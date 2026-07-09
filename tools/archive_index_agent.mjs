// 過去工事アーカイブ AI索引エージェント（ローカル実行・A案）
// ------------------------------------------------------------
// Drive「10.過去工事アーカイブ」を正本として工事フォルダ→PDFを列挙し、
// Gemini で書類種別/日付/要約/発注者/年度/工種を抽出 → Supabase へ upsert。
// Gemini に渡すバイト列は E: のローカル原本を優先（DL回避）、無ければ Drive からDL。
// drive_file_id を正本キーに冪等。既存はスキップ（--force で再索引）。
//
// 実行（portal-api ディレクトリから）:
//   node tools/archive_index_agent.mjs --kouji "(仮称)豊玉認定こども園建設工事(建築主体)"
//   node tools/archive_index_agent.mjs            # 全工事
// オプション: --scope kouji|jinji  --limit N  --force  --concurrency N  --dry
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ensureFolderPath, driveListChildren, driveDownload } from '../googleDrive.js';

// ---- 引数 ----
const argv = process.argv.slice(2);
const getOpt = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : def; };
const hasFlag = (name) => argv.includes(name);
const SCOPE = getOpt('--scope', 'kouji') === 'jinji' ? 'jinji' : 'kouji';
const ONLY_KOUJI = getOpt('--kouji', null);
const LIMIT = getOpt('--limit', null) ? parseInt(getOpt('--limit'), 10) : null;
const FORCE = hasFlag('--force');
const DRY = hasFlag('--dry');
const CONCURRENCY = getOpt('--concurrency', null) ? parseInt(getOpt('--concurrency'), 10) : 4;

const ARCHIVE_ROOT_NAME = SCOPE === 'jinji' ? '11.人事アーカイブ' : '10.過去工事アーカイブ';
const LOCAL_ROOT = 'E:/過去工事資料';
const SHARED_DRIVE_ROOT_ID = process.env.SHARED_DRIVE_ROOT_ID || '0AK5TgtO_Sr4RUk9PVA';
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE = 'https://generativelanguage.googleapis.com';
const INLINE_LIMIT = 15 * 1024 * 1024;
if (!KEY) { console.error('GEMINI_API_KEY 未設定'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- チェックポイント（抽出結果をローカル保存し、再実行時はGeminiを呼ばず再利用） ----
const CP_PATH = `D:/01.claude code/04.アプリ/04.portal-api/tools/_index_checkpoint_${SCOPE}.json`;
const checkpoint = new Map(); // drive_file_id -> row
function loadCheckpoint() {
  try { const o = JSON.parse(fs.readFileSync(CP_PATH, 'utf8')); for (const [k, v] of Object.entries(o)) checkpoint.set(k, v); } catch {}
}
let cpDirty = false;
function saveCheckpoint() {
  if (!cpDirty) return;
  const o = {}; for (const [k, v] of checkpoint) o[k] = v;
  fs.writeFileSync(CP_PATH, JSON.stringify(o), 'utf8'); cpDirty = false;
}

// ---- Gemini 抽出 ----
const PROMPT = [
  'あなたは日本の建設会社の書類管理担当です。これは過去の工事書類をスキャンしたPDF（画像・多ページ）です。',
  'PDF全体を読み取り、検索用の索引メタデータをJSONで返してください。1つのPDFに複数種類の書類が綴じられている場合があります。',
  '- doc_type: 書類種別。次から該当する主なものを最大3つ「/」区切りで。候補=契約書/変更契約/設計図/特記仕様書/共通仕様書/数量書・内訳書/施工計画書/工程表/施工図/品質管理記録/出来形管理/安全書類/打合せ記録・議事録/工事写真/完成図書/検査記録/請求・出来高/官公庁提出書類/その他',
  '- doc_date: 文書の代表日付。西暦 YYYY-MM-DD。和暦(令和・平成)は西暦へ変換。複数あれば最も代表的な1つ。不明は空文字',
  '- date_text: 文書内に出てくる主要な日付を原文のまま（和暦可・複数はカンマ区切り）。なければ空文字',
  '- summary: この書類の内容を日本語で3〜5文に要約。何の書類で・何が書かれているかが検索で分かるように',
  '- client_name: 発注者（例: 長崎県、対馬市、九州防衛局、○○事務所）。工事の発注者を優先し、通知書等の差出人は避ける。不明は空文字',
  '- fiscal_year: 年度（例: 令和6年度）。分かれば西暦も併記（例: 令和6年度(2024)）。不明は空文字',
  '- work_type: 工種（例: 建築主体/改修/耐震改修/設備/電気/治山/漁港。工事名や内容から代表的に）',
  '- keywords: 検索に使う固有名詞・工種・材料・場所・施設名などを半角スペース区切りで最大12語',
  '推測で埋めず、読み取れない項目は空文字にしてください。',
].join('\n');
const SCHEMA = { type: 'OBJECT', properties: {
  doc_type: { type: 'STRING' }, doc_date: { type: 'STRING' }, date_text: { type: 'STRING' },
  summary: { type: 'STRING' }, client_name: { type: 'STRING' }, fiscal_year: { type: 'STRING' },
  work_type: { type: 'STRING' }, keywords: { type: 'STRING' },
}, required: ['doc_type', 'summary'] };

async function uploadFile(buf, displayName) {
  const start = await fetch(`${BASE}/upload/v1beta/files?key=${KEY}`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw new Error(`upload start ${start.status}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  const up = await fetch(uploadUrl, { method: 'POST',
    headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: buf });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  let file = (await up.json()).file;
  for (let i = 0; i < 30 && file.state !== 'ACTIVE'; i++) {
    await sleep(2000);
    file = await (await fetch(`${BASE}/v1beta/${file.name}?key=${KEY}`)).json();
    if (file.state === 'FAILED') throw new Error('file FAILED');
  }
  if (file.state !== 'ACTIVE') throw new Error('file not ACTIVE');
  return file;
}
async function deleteFile(name) { try { await fetch(`${BASE}/v1beta/${name}?key=${KEY}`, { method: 'DELETE' }); } catch {} }

async function geminiExtract(buf, name) {
  let uploaded = null;
  try {
    let parts;
    if (buf.length < INLINE_LIMIT) parts = [{ text: PROMPT }, { inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }];
    else { uploaded = await uploadFile(buf, name); parts = [{ text: PROMPT }, { fileData: { mimeType: 'application/pdf', fileUri: uploaded.uri } }]; }
    const body = { contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA } };
    const resp = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const text = (await resp.json()).candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return JSON.parse(text);
  } finally { if (uploaded) await deleteFile(uploaded.name); }
}

// ---- ローカル原本の索引（工事名→{ファイル名→絶対パス}） ----
function buildLocalIndex() {
  const map = new Map();
  if (!fs.existsSync(LOCAL_ROOT)) return map;
  for (const ent of fs.readdirSync(LOCAL_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const files = new Map();
    for (const f of fs.readdirSync(path.join(LOCAL_ROOT, ent.name))) {
      if (f.toLowerCase().endsWith('.pdf')) files.set(f, path.join(LOCAL_ROOT, ent.name, f));
    }
    map.set(ent.name, files);
  }
  return map;
}

const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---- main ----
(async () => {
  console.log(`索引エージェント起動  scope=${SCOPE}  並列=${CONCURRENCY}  ${DRY ? '[ドライラン]' : ''}${FORCE ? ' [強制再索引]' : ''}`);
  const rootId = await ensureFolderPath([ARCHIVE_ROOT_NAME], SHARED_DRIVE_ROOT_ID);
  const koujiFolders = (await driveListChildren(rootId))
    .filter((c) => c.mimeType === 'application/vnd.google-apps.folder')
    .filter((c) => !ONLY_KOUJI || c.name === ONLY_KOUJI)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (!koujiFolders.length) { console.error('対象工事フォルダが見つかりません', ONLY_KOUJI ? `(--kouji ${ONLY_KOUJI})` : ''); process.exit(1); }

  const localIdx = buildLocalIndex();
  loadCheckpoint();

  // 既存の索引済み drive_file_id（スキップ用）
  const done = new Set();
  if (!FORCE) {
    let from = 0;
    for (;;) {
      const { data } = await sb.from('archive_document_index').select('drive_file_id').eq('status', 'indexed').range(from, from + 999);
      (data || []).forEach((r) => r.drive_file_id && done.add(r.drive_file_id));
      if (!data || data.length < 1000) break; from += 1000;
    }
  }

  // 全タスク（PDFファイル）を平坦化
  const tasks = [];
  for (const kf of koujiFolders) {
    const children = await driveListChildren(kf.id);
    const pdfs = children.filter((c) => c.mimeType === 'application/pdf' || c.name.toLowerCase().endsWith('.pdf'));
    for (const f of pdfs) {
      if (!FORCE && done.has(f.id)) continue;
      tasks.push({ koujiName: kf.name, koujiFolderId: kf.id, fileId: f.id, fileName: f.name });
    }
    if (LIMIT && tasks.length >= LIMIT) break;
  }
  const targets = LIMIT ? tasks.slice(0, LIMIT) : tasks;
  console.log(`対象PDF: ${targets.length}件（工事 ${koujiFolders.length}件 / スキップ済 ${done.size}件）\n`);
  if (!targets.length) { console.log('新規対象なし。終了'); return; }

  const rowsByKouji = new Map(); // 発注者の多数決補完用
  let ok = 0, err = 0, idx = 0;

  async function worker() {
    for (;;) {
      const i = idx++; if (i >= targets.length) return;
      const t = targets[i];
      const tag = `[${i + 1}/${targets.length}] ${t.koujiName.slice(0, 14)}…/${t.fileName}`;
      try {
        let row = checkpoint.get(t.fileId);
        if (row && !FORCE) {
          // チェックポイント再利用（Gemini呼ばず）
          console.log(`${tag}  CACHE  種別=${row.doc_type}`);
        } else {
          // バイト列取得: ローカル優先→Drive
          let buf;
          const localFile = localIdx.get(t.koujiName)?.get(t.fileName);
          if (localFile) buf = fs.readFileSync(localFile);
          else buf = (await driveDownload(t.fileId)).buffer;

          let out; let attempt = 0;
          for (;;) { try { out = await geminiExtract(buf, t.fileName); break; }
            catch (e) { if (++attempt >= 2) throw e; await sleep(3000); } }

          row = {
            scope: SCOPE, drive_file_id: t.fileId, kouji_folder_id: t.koujiFolderId, kouji_name: t.koujiName,
            file_name: t.fileName, file_size: buf.length,
            doc_type: out.doc_type || null, doc_date: isValidDate(out.doc_date) ? out.doc_date : null,
            date_text: out.date_text || null, summary: out.summary || null,
            client_name: out.client_name || null, fiscal_year: out.fiscal_year || null,
            work_type: out.work_type || null, keywords: out.keywords || null,
            raw_json: out, model: MODEL, status: 'indexed', error_message: null, indexed_at: new Date().toISOString(),
          };
          checkpoint.set(t.fileId, row); cpDirty = true; saveCheckpoint();
          console.log(`${tag}  OK  種別=${row.doc_type}  発注者=${row.client_name || '-'}`);
        }
        if (!rowsByKouji.has(t.koujiName)) rowsByKouji.set(t.koujiName, []);
        rowsByKouji.get(t.koujiName).push(row);
        ok++;
      } catch (e) {
        err++;
        const row = { scope: SCOPE, drive_file_id: t.fileId, kouji_folder_id: t.koujiFolderId, kouji_name: t.koujiName,
          file_name: t.fileName, status: 'error', error_message: String(e.message || e).slice(0, 500), indexed_at: new Date().toISOString() };
        if (!DRY) await sb.from('archive_document_index').upsert(row, { onConflict: 'drive_file_id' });
        console.log(`${tag}  ERROR ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  // 発注者の多数決で空欄を補完してから upsert
  let written = 0;
  for (const [, rows] of rowsByKouji) {
    const counts = {};
    for (const r of rows) if (r.client_name) counts[r.client_name] = (counts[r.client_name] || 0) + 1;
    const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    for (const r of rows) { if (!r.client_name && majority) r.client_name = majority; }
    if (!DRY) {
      for (let j = 0; j < rows.length; j += 100) {
        const { error } = await sb.from('archive_document_index').upsert(rows.slice(j, j + 100), { onConflict: 'drive_file_id' });
        if (error) console.error('upsert error:', error.message); else written += Math.min(100, rows.length - j);
      }
    }
  }
  console.log(`\n完了: 成功 ${ok} / エラー ${err} / DB書込 ${DRY ? '(ドライラン)' : written}件`);
})();
