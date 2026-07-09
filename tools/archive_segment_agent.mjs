// 過去工事アーカイブ セグメント索引エージェント（書類単位・本文全文・ページ範囲）
// ------------------------------------------------------------
// Drive「10.過去工事アーカイブ」を正本に工事フォルダ→PDFを列挙し、各PDFを
//   1) fitz で 20ページ単位に分割（本文全文だと出力上限を超えるため）
//   2) 断片ごとに Gemini で「綴じ書類」に分解＋本文全文＋ページ範囲を抽出
//   3) ページ番号を元PDF換算に補正し、断片境界で分断された書類を統合
//   4) 親 archive_document_index を upsert、子 archive_document_segments を置換
// バイト列は E: のローカル原本を優先（無ければ Drive DL）。drive_file_id で冪等。
// チェックポイント（本文込み）で再実行時は Gemini/分割を呼ばず再投入できる。
//
// 実行（portal-api ディレクトリから）:
//   node tools/archive_segment_agent.mjs --kouji "<工事名>"   # 1工事
//   node tools/archive_segment_agent.mjs                      # 全工事
// オプション: --scope kouji|jinji  --limit N  --force  --concurrency N  --chunk 20
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { ensureFolderPath, driveListChildren, driveDownload } from '../googleDrive.js';

const argv = process.argv.slice(2);
const getOpt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const hasFlag = (n) => argv.includes(n);
const SCOPE = getOpt('--scope', 'kouji') === 'jinji' ? 'jinji' : 'kouji';
const ONLY_KOUJI = getOpt('--kouji', null);
const LIMIT = getOpt('--limit', null) ? parseInt(getOpt('--limit'), 10) : null;
const FORCE = hasFlag('--force');
const DRY = hasFlag('--dry');
const CONCURRENCY = getOpt('--concurrency', null) ? parseInt(getOpt('--concurrency'), 10) : 3;
const CHUNK_SIZE = getOpt('--chunk', null) ? parseInt(getOpt('--chunk'), 10) : 12;

const ARCHIVE_ROOT_NAME = SCOPE === 'jinji' ? '11.人事アーカイブ' : '10.過去工事アーカイブ';
const LOCAL_ROOT = 'E:/過去工事資料';
const SHARED_DRIVE_ROOT_ID = process.env.SHARED_DRIVE_ROOT_ID || '0AK5TgtO_Sr4RUk9PVA';
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE = 'https://generativelanguage.googleapis.com';
const INLINE_LIMIT = 15 * 1024 * 1024;
const TMP = 'C:/Users/toki/AppData/Local/Temp/archive_seg';
const CHUNK_SCRIPT = path.resolve('tools/pdf_chunk.py');
if (!KEY) { console.error('GEMINI_API_KEY 未設定'); process.exit(1); }
fs.mkdirSync(TMP, { recursive: true });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- チェックポイント ----
const CP_PATH = `D:/01.claude code/04.アプリ/04.portal-api/tools/_seg_checkpoint_${SCOPE}.json`;
const checkpoint = new Map();
function loadCheckpoint() { try { const o = JSON.parse(fs.readFileSync(CP_PATH, 'utf8')); for (const [k, v] of Object.entries(o)) checkpoint.set(k, v); } catch {} }
function saveCheckpoint() { const o = {}; for (const [k, v] of checkpoint) o[k] = v; fs.writeFileSync(CP_PATH, JSON.stringify(o), 'utf8'); }

// ---- Gemini ----
const PROMPT = [
  'これは工事書類をスキャンした画像PDF（連続する複数ページ／元PDFの一部の場合あり）です。',
  '綴じられている「書類」ごとに区切り、各書類の情報と本文全文を JSON(segments配列) で、ページ先頭から順に返してください。',
  '- seg_index: 0始まりの通し番号（この断片内で）',
  '- doc_type: 契約書/変更契約/設計図/特記仕様書/共通仕様書/数量書・内訳書/施工計画書/工程表/施工図/品質管理記録/出来形管理/安全書類/打合せ記録・議事録/工事写真/検査記録/請求・出来高/官公庁提出書類/その他 から',
  '- title: 書類名（文書表題。例: 工事請負契約書、前払金保証証書、監理技術者変更届）',
  '- doc_date: 代表日付 YYYY-MM-DD（和暦→西暦）。無ければ空文字',
  '- client_name: 発注者。無ければ空文字',
  '- work_type: 工種。無ければ空文字',
  '- page_start, page_end: この断片内でのページ番号（1始まり・両端含む）。※元PDF換算は不要',
  '- body_text: 文章主体の書類（契約書/仕様書/報告書/請求書/通知/議事録など）は本文を要約せず全文書き起こす。表は可能な範囲で整形、押印は[印]、判読不能は[判読不能]、金額・日付・氏名・番号は正確に。',
  '  ただし図面類（設計図/施工図/工程表/配筋図/伏図など）は全文起こしをせず、図面名・縮尺・記載されている主な情報（室名/符号/寸法の種類/凡例/変更箇所など）を要点で簡潔に（最大400字程度）記述する。',
  '- summary: 1〜2文の要約',
  '- keywords: 検索用の語を半角スペース区切りで最大10語',
  '書類の境目はページ単位で判断し、page_start/page_end が全書類で断片の全ページを覆うようにしてください。',
].join('\n');
const SEG = { type: 'OBJECT', properties: {
  seg_index: { type: 'INTEGER' }, doc_type: { type: 'STRING' }, title: { type: 'STRING' },
  doc_date: { type: 'STRING' }, client_name: { type: 'STRING' }, work_type: { type: 'STRING' },
  page_start: { type: 'INTEGER' }, page_end: { type: 'INTEGER' },
  body_text: { type: 'STRING' }, summary: { type: 'STRING' }, keywords: { type: 'STRING' },
}, required: ['doc_type', 'title', 'page_start', 'page_end', 'body_text'] };
const SCHEMA = { type: 'OBJECT', properties: { segments: { type: 'ARRAY', items: SEG } }, required: ['segments'] };

async function uploadFile(buf, name) {
  const s = await fetch(`${BASE}/upload/v1beta/files?key=${KEY}`, { method: 'POST', headers: {
    'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': 'application/pdf', 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: name } }) });
  if (!s.ok) throw new Error(`upload start ${s.status}`);
  const url = s.headers.get('x-goog-upload-url');
  const u = await fetch(url, { method: 'POST', headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buf });
  if (!u.ok) throw new Error(`upload ${u.status}`);
  let f = (await u.json()).file;
  for (let i = 0; i < 30 && f.state !== 'ACTIVE'; i++) { await sleep(2000); f = await (await fetch(`${BASE}/v1beta/${f.name}?key=${KEY}`)).json(); if (f.state === 'FAILED') throw new Error('file FAILED'); }
  if (f.state !== 'ACTIVE') throw new Error('file not ACTIVE');
  return f;
}
const deleteFile = (name) => fetch(`${BASE}/v1beta/${name}?key=${KEY}`, { method: 'DELETE' }).catch(() => {});

async function extractChunk(buf, name) {
  let uploaded = null;
  try {
    let parts;
    if (buf.length < INLINE_LIMIT) parts = [{ text: PROMPT }, { inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }];
    else { uploaded = await uploadFile(buf, name); parts = [{ text: PROMPT }, { fileData: { mimeType: 'application/pdf', fileUri: uploaded.uri } }]; }
    const body = { contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 65536 } };
    const resp = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
    const raw = await resp.json();
    const cand = raw.candidates?.[0];
    if (cand?.finishReason && cand.finishReason !== 'STOP') throw new Error(`finishReason=${cand.finishReason}（断片が大きすぎる可能性）`);
    const text = cand?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return JSON.parse(text).segments || [];
  } finally { if (uploaded) await deleteFile(uploaded.name); }
}

// ---- ローカル原本索引 ----
function buildLocalIndex() {
  const map = new Map();
  if (!fs.existsSync(LOCAL_ROOT)) return map;
  for (const ent of fs.readdirSync(LOCAL_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const files = new Map();
    for (const f of fs.readdirSync(path.join(LOCAL_ROOT, ent.name))) if (f.toLowerCase().endsWith('.pdf')) files.set(f, path.join(LOCAL_ROOT, ent.name, f));
    map.set(ent.name, files);
  }
  return map;
}

// YYYY-MM-DD 形式かつ月日が実在範囲（"2021-00-00" のような年のみ推定を弾く）。
const isValidDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
};
const normTitle = (s) => String(s || '').replace(/[\s　・（）()「」]/g, '').toLowerCase();

// python(pdf_chunk.py) を呼ぶ。ranges 省略で page_count のみ、指定で範囲PDFを切り出す。
function pyChunk(srcPath, outDir, ranges) {
  fs.mkdirSync(outDir, { recursive: true });
  const argsFile = path.join(outDir, '_args.json');
  fs.writeFileSync(argsFile, JSON.stringify({ input: srcPath, out_dir: outDir, ...(ranges ? { ranges } : {}) }), 'utf8');
  const r = spawnSync('python', [CHUNK_SCRIPT, argsFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('pdf_chunk.py 失敗: ' + (r.stderr || r.error?.message || '').slice(0, 200));
  return JSON.parse(r.stdout);
}
const isTruncErr = (e) => /MAX_TOKENS|finishReason/.test(String(e?.message || ''));

// 断片境界で分断された書類だけを統合する最終パス（同一タイトル＋境界ページで隣接時のみ）。
function stitch(segs, boundaries) {
  segs.sort((a, b) => a.page_start - b.page_start || a.page_end - b.page_end);
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.page_start === prev.page_end + 1 && boundaries.has(prev.page_end) && normTitle(prev.title) === normTitle(s.title) && normTitle(s.title)) {
      prev.body_text = `${prev.body_text}\n${s.body_text || ''}`.trim();
      prev.page_end = Math.max(prev.page_end, s.page_end);
      if (!prev.summary && s.summary) prev.summary = s.summary;
      if (!prev.doc_date && s.doc_date) prev.doc_date = s.doc_date;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

// PDF1本を索引化して { parent, segments } を返す（Gemini/分割を実行）
async function indexPdf(t, localIdx) {
  const outDir = path.join(TMP, t.fileId);
  let srcPath = localIdx.get(t.koujiName)?.get(t.fileName);
  let downloaded = null;
  if (!srcPath) { // Drive からDL
    const { buffer } = await driveDownload(t.fileId);
    downloaded = path.join(TMP, t.fileId + '_src.pdf');
    fs.writeFileSync(downloaded, buffer);
    srcPath = downloaded;
  }
  try {
    const { page_count } = pyChunk(srcPath, outDir); // ページ数のみ
    const all = []; // 元PDF換算のセグメント
    const boundaries = new Set(); // 断片の末尾ページ（統合判定用）
    // 初期の連続ページ範囲。MAX_TOKENS の断片は半分に再分割して処理（密な所だけ細かく）。
    const queue = [];
    for (let s = 1; s <= page_count; s += CHUNK_SIZE) queue.push([s, Math.min(s + CHUNK_SIZE - 1, page_count)]);
    while (queue.length) {
      const [s, e] = queue.shift();
      const { files } = pyChunk(srcPath, outDir, [[s, e]]);
      const buf = fs.readFileSync(files[0].file);
      let segs;
      try {
        let attempt = 0;
        // truncation は即 subdivide（外側catch）。503等の一時障害は指数バックオフで最大6回。
        for (;;) { try { segs = await extractChunk(buf, `r_${s}_${e}.pdf`); break; } catch (err) { if (isTruncErr(err) || ++attempt >= 6) throw err; await sleep(Math.min(30000, 2000 * 2 ** (attempt - 1))); } }
      } catch (err) {
        try { fs.unlinkSync(files[0].file); } catch {}
        if (isTruncErr(err) && e > s) { const mid = Math.floor((s + e) / 2); queue.unshift([mid + 1, e]); queue.unshift([s, mid]); continue; }
        if (isTruncErr(err) && e === s) { // 1ページでも過大：本文省略で記録しPDF全体は失敗させない
          boundaries.add(e);
          all.push({ doc_type: 'その他', title: `(本文省略 p${s})`, doc_date: null, client_name: null, work_type: null, page_start: s, page_end: s, body_text: '', summary: '情報量が多く本文の自動テキスト化を省略しました。原本の該当ページを参照してください。', keywords: null });
          continue;
        }
        throw err;
      }
      try { fs.unlinkSync(files[0].file); } catch {}
      boundaries.add(e);
      for (const seg of segs) {
        const gStart = s + (seg.page_start || 1) - 1;
        const gEnd = s + (seg.page_end || seg.page_start || 1) - 1;
        all.push({
          doc_type: seg.doc_type || null, title: seg.title || null, doc_date: isValidDate(seg.doc_date) ? seg.doc_date : null,
          client_name: seg.client_name || null, work_type: seg.work_type || null,
          page_start: gStart, page_end: gEnd, body_text: seg.body_text || '', summary: seg.summary || null, keywords: seg.keywords || null,
        });
      }
    }
    const stitched = stitch(all, boundaries);
    all.length = 0; all.push(...stitched);
    // 親メタ集約
    const typeSet = new Map();
    for (const s of all) for (const tp of String(s.doc_type || '').split('/').map((x) => x.trim()).filter(Boolean)) typeSet.set(tp, (typeSet.get(tp) || 0) + 1);
    const topTypes = [...typeSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]).join('/');
    const clientCount = {};
    for (const s of all) if (s.client_name) clientCount[s.client_name] = (clientCount[s.client_name] || 0) + 1;
    const majorityClient = Object.entries(clientCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const dates = all.map((s) => s.doc_date).filter(Boolean).sort();
    const kwSet = new Set(); for (const s of all) for (const w of String(s.keywords || '').split(/\s+/).filter(Boolean)) kwSet.add(w);
    const titles = all.map((s) => s.title).filter(Boolean);
    const parent = {
      scope: SCOPE, drive_file_id: t.fileId, kouji_folder_id: t.koujiFolderId, kouji_name: t.koujiName,
      file_name: t.fileName, file_size: fs.statSync(srcPath).size,
      doc_type: topTypes || null, doc_date: dates.length ? dates[dates.length - 1] : null,
      date_text: dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : null,
      summary: titles.slice(0, 6).join(' / ') + (titles.length > 6 ? ` ほか${titles.length - 6}件` : ''),
      client_name: majorityClient, fiscal_year: null, work_type: all.find((s) => s.work_type)?.work_type || null,
      keywords: [...kwSet].slice(0, 40).join(' '), page_count, seg_count: all.length,
      raw_json: null, model: MODEL, status: 'indexed', error_message: null, indexed_at: new Date().toISOString(),
    };
    return { parent, segments: all };
  } finally {
    if (downloaded) { try { fs.unlinkSync(downloaded); } catch {} }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

// 親＋子を DB へ（親 upsert→id 取得→子を置換）
async function writeToDb(t, parent, segments) {
  // キャッシュ由来の不正日付（旧ロジックが通した "YYYY-MM-00" 等）もここで無害化する。
  const safeDate = (d) => (isValidDate(d) ? d : null);
  const parentRow = { ...parent, doc_date: safeDate(parent.doc_date) };
  const { data: prow, error: perr } = await sb.from('archive_document_index').upsert(parentRow, { onConflict: 'drive_file_id' }).select('id').single();
  if (perr) throw perr;
  const docId = prow.id;
  await sb.from('archive_document_segments').delete().eq('drive_file_id', t.fileId);
  const rows = segments.map((s, i) => ({
    document_id: docId, drive_file_id: t.fileId, scope: SCOPE, kouji_folder_id: t.koujiFolderId, kouji_name: t.koujiName, file_name: t.fileName,
    seg_index: i, doc_type: s.doc_type, title: s.title, doc_date: safeDate(s.doc_date), date_text: null,
    client_name: s.client_name, fiscal_year: null, work_type: s.work_type,
    page_start: s.page_start, page_end: s.page_end, body_text: s.body_text, summary: s.summary, keywords: s.keywords, model: MODEL,
  }));
  for (let j = 0; j < rows.length; j += 100) {
    const { error } = await sb.from('archive_document_segments').insert(rows.slice(j, j + 100));
    if (error) throw error;
  }
}

(async () => {
  console.log(`セグメント索引 起動  scope=${SCOPE}  並列=${CONCURRENCY}  chunk=${CHUNK_SIZE}pp${FORCE ? ' [強制]' : ''}`);
  const rootId = await ensureFolderPath([ARCHIVE_ROOT_NAME], SHARED_DRIVE_ROOT_ID);
  const koujiFolders = (await driveListChildren(rootId))
    .filter((c) => c.mimeType === 'application/vnd.google-apps.folder')
    .filter((c) => !ONLY_KOUJI || c.name === ONLY_KOUJI)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (!koujiFolders.length) { console.error('対象工事なし'); process.exit(1); }

  const localIdx = buildLocalIndex();
  loadCheckpoint();

  // 既に segments を持つ drive_file_id（スキップ用）
  const done = new Set();
  if (!FORCE) {
    let from = 0;
    for (;;) {
      const { data } = await sb.from('archive_document_index').select('drive_file_id,seg_count').eq('scope', SCOPE).eq('status', 'indexed').gt('seg_count', 0).range(from, from + 999);
      (data || []).forEach((r) => r.drive_file_id && done.add(r.drive_file_id));
      if (!data || data.length < 1000) break; from += 1000;
    }
  }

  const tasks = [];
  for (const kf of koujiFolders) {
    const pdfs = (await driveListChildren(kf.id)).filter((c) => c.mimeType === 'application/pdf' || c.name.toLowerCase().endsWith('.pdf'));
    for (const f of pdfs) { if (!FORCE && done.has(f.id)) continue; tasks.push({ koujiName: kf.name, koujiFolderId: kf.id, fileId: f.id, fileName: f.name }); }
  }
  const targets = LIMIT ? tasks.slice(0, LIMIT) : tasks;
  console.log(`対象PDF: ${targets.length}件（工事 ${koujiFolders.length} / スキップ済 ${done.size}）\n`);
  if (!targets.length) { console.log('新規対象なし'); return; }

  let ok = 0, err = 0, idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++; if (i >= targets.length) return;
      const t = targets[i];
      const tag = `[${i + 1}/${targets.length}] ${t.koujiName.slice(0, 12)}…/${t.fileName}`;
      try {
        let cached = FORCE ? null : checkpoint.get(t.fileId);
        let parent, segments;
        if (cached) { parent = cached.parent; segments = cached.segments; }
        else { const r = await indexPdf(t, localIdx); parent = r.parent; segments = r.segments; checkpoint.set(t.fileId, r); saveCheckpoint(); }
        if (!DRY) await writeToDb(t, parent, segments);
        ok++;
        console.log(`${tag}  OK  書類${segments.length}件 (${parent.page_count}pp)  ${cached ? '[cache]' : ''}${DRY ? ' [dry]' : ''}`);
        if (DRY) for (const s of segments) console.log(`      p${s.page_start}-${s.page_end} ${s.doc_type}/${s.title} (${(s.body_text || '').length}字)`);
      } catch (e) {
        err++;
        try { await sb.from('archive_document_index').upsert({ scope: SCOPE, drive_file_id: t.fileId, kouji_folder_id: t.koujiFolderId, kouji_name: t.koujiName, file_name: t.fileName, status: 'error', error_message: String(e.message || e).slice(0, 500), indexed_at: new Date().toISOString() }, { onConflict: 'drive_file_id' }); } catch {}
        console.log(`${tag}  ERROR ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  console.log(`\n完了: 成功 ${ok} / エラー ${err}`);
})();
