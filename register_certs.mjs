// 資格者証レコード（Claudeが束ねPDFから読み取った内容）を一括登録するヘルパー。
// ポータルの照合・保存・upsert ロジックを移植し、Gemini を使わずに登録する。
//
// 入力: records JSON ファイル（配列）。各要素:
//   {
//     staff_name:        "中原 釈統",          // 必須。証書面の氏名
//     company:           "中原建設",            // 任意（照合補助。空でも staff_master から決まる）
//     birth_date:        "1979-01-23",          // 任意（同姓異体字の一意化に使用, YYYY-MM-DD）
//     qualification_name:"玉掛け技能講習",       // 必須
//     category:          "技能講習",            // 任意（新規マスタ作成時のカテゴリ。既定 その他）
//     acquired_date:     "2015-04-01",          // 任意 YYYY-MM-DD
//     expiry_date:       "",                    // 任意 YYYY-MM-DD
//     cert_number:       "第12345号",            // 任意
//     issuer:            "○○協会",              // 任意
//     honseki:           "",                    // 任意
//     source_pdf:        "G:\\...\\xxx.pdf",     // 必須。原本PDFのパス
//     page:              3                       // 必須。原本PDFの該当ページ(1始まり)
//   }
//
//   node register_certs.mjs <records.json> [--dry-run]

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { driveUpload, ensureFolderPath, driveConfigured } from './googleDrive.js';
import { randomUUID } from 'crypto';

dotenv.config();
const DRY = process.argv.includes('--dry-run');
const recordsPath = process.argv[2];
if (!recordsPath) { console.error('使い方: node register_certs.mjs <records.json> [--dry-run]'); process.exit(1); }
if (!driveConfigured()) { console.error('Drive 未設定'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- 正規化（ポータル移植） ----
const KANJI_NUM = { '一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9' };
function normQual(s) {
  return String(s||'').replace(/[（(].*?[)）]/g,'').replace(/[一二三四五六七八九]/g,m=>KANJI_NUM[m]).replace(/[\s　]/g,'').toLowerCase();
}
// 氏名: 空白除去＋異体字フォールド
function normName(s) {
  return String(s||'').normalize('NFKC').replace(/[\s　]/g,'')
    .replace(/[斎斉齋齊]/g,'斉').replace(/[邉邊]/g,'辺').replace(/[髙]/g,'高').replace(/[﨑崎]/g,'崎')
    .replace(/[祐佑]/g,'祐').replace(/[渡邉渡邊]/g,'渡辺');
}
function cleanIso(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s||''))?s:null; }

// ---- マスタ読込 ----
const { data: staff } = await sb.from('staff_master').select('id,name,company,birth_date');
const { data: quals } = await sb.from('qualification_master').select('id,name,category,has_expiry');
const qualByNorm = new Map(quals.map(q=>[normQual(q.name), q]));

function matchStaff(rec) {
  const n = normName(rec.staff_name);
  if (!n) return null;
  let hits = staff.filter(s=>normName(s.name)===n);
  if (hits.length===1) return hits[0];
  if (hits.length>1 && rec.birth_date) {
    const b = hits.filter(s=>s.birth_date===rec.birth_date);
    if (b.length===1) return b[0];
  }
  if (hits.length>1) return hits[0]; // 同名複数で生年月日も決まらない→先頭（ログで警告）
  // 部分一致フォールバック（姓名どちらか）
  const part = staff.filter(s=>{ const sn=normName(s.name); return sn.includes(n)||n.includes(sn); });
  return part.length===1 ? part[0] : null;
}

async function ensureQual(rec) {
  const key = normQual(rec.qualification_name);
  if (qualByNorm.has(key)) return qualByNorm.get(key);
  // 部分一致
  for (const q of quals) { const qk=normQual(q.name); if (qk && (qk.includes(key)||key.includes(qk))) return q; }
  // 新規作成（冪等）
  const category = rec.category || 'その他';
  const has_expiry = !!cleanIso(rec.expiry_date);
  if (DRY) { const fake={id:'(新規予定)',name:rec.qualification_name,category,has_expiry}; return fake; }
  const { data, error } = await sb.from('qualification_master').insert({ name: rec.qualification_name, category, has_expiry }).select().single();
  if (error) {
    if (error.code==='23505') { const { data: ex } = await sb.from('qualification_master').select('*').eq('name',rec.qualification_name).single(); return ex; }
    throw error;
  }
  quals.push(data); qualByNorm.set(key, data);
  return data;
}

// PDFの1ページを単一PDFに抽出
const pdfCache = new Map();
async function loadPdf(path){ if(!pdfCache.has(path)) pdfCache.set(path, await PDFDocument.load(readFileSync(path))); return pdfCache.get(path); }
async function extractPage(path, page1){
  const src = await loadPdf(path);
  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [page1-1]);
  out.addPage(pg);
  return Buffer.from(await out.save());
}

let inserted=0, updated=0, kept=0, failed=0, newQuals=0;
const unmatched=[];

const records = JSON.parse(readFileSync(recordsPath,'utf8'));
console.log(`登録対象: ${records.length} 件${DRY?'  [dry-run]':''}\n`);

for (const rec of records) {
  try {
    const st = matchStaff(rec);
    if (!st) { unmatched.push(rec.staff_name+' / '+rec.qualification_name); console.warn(`? 社員未照合: ${rec.staff_name} (${rec.qualification_name})`); failed++; continue; }
    const q = await ensureQual(rec);
    if (String(q.id).includes('新規')|| (!DRY && !qualByNorm.has(normQual(rec.qualification_name)))) {}

    // 原本ページを Drive へ
    const company = (st.company||'会社未設定').trim();
    const segs = [company.replace(/[\\/:*?"<>|]/g,'_'), String(st.name).replace(/[\\/:*?"<>|]/g,'_')];
    let cert_image_path = null;
    if (!DRY) {
      const buf = await extractPage(rec.source_pdf, rec.page);
      const folderId = await ensureFolderPath(segs);
      const fileId = await driveUpload({ name: `${Date.now()}-${randomUUID().slice(0,8)}.pdf`, buffer: buf, mimeType: 'application/pdf', folderId });
      cert_image_path = `drive:${fileId}`;
    }

    // upsert（同一 staff×qual は新しい日付を残す）
    const row = {
      staff_id: st.id, qualification_id: q.id,
      acquired_date: cleanIso(rec.acquired_date), expiry_date: cleanIso(rec.expiry_date),
      cert_number: rec.cert_number||null, issuer: rec.issuer||null, honseki: rec.honseki||null,
      cert_image_path,
    };
    if (DRY) { console.log(`[dry] ${st.name} / ${q.name}${String(q.id).includes('新規')?'(新規マスタ)':''}  取得${row.acquired_date||'-'} 期限${row.expiry_date||'-'}  p${rec.page}`); inserted++; continue; }

    const { data: ex } = await sb.from('staff_qualifications').select('*').eq('staff_id',st.id).eq('qualification_id',q.id).maybeSingle();
    if (!ex) {
      const { error } = await sb.from('staff_qualifications').insert(row); if (error) throw error;
      inserted++; console.log(`+ ${st.name} / ${q.name}`);
    } else {
      const newKey = row.acquired_date||row.expiry_date||'';
      const oldKey = ex.acquired_date||ex.expiry_date||'';
      if (newKey > oldKey) {
        const upd = { ...row };
        // 欠損は既存を温存
        for (const k of ['acquired_date','expiry_date','cert_number','issuer','honseki','cert_image_path']) if (upd[k]==null) upd[k]=ex[k];
        const { error } = await sb.from('staff_qualifications').update(upd).eq('id',ex.id); if (error) throw error;
        updated++; console.log(`~ ${st.name} / ${q.name}（更新）`);
      } else {
        // 既存が新しい→ただし画像が無ければ今回の画像を補完
        if (!ex.cert_image_path && cert_image_path) { await sb.from('staff_qualifications').update({cert_image_path}).eq('id',ex.id); }
        kept++; console.log(`= ${st.name} / ${q.name}（据置）`);
      }
    }
  } catch (e) {
    failed++; console.error(`! 失敗: ${rec.staff_name} / ${rec.qualification_name}: ${e.message}`);
  }
}

console.log(`\n完了${DRY?'（dry-run）':''}: 追加${inserted} 更新${updated} 据置${kept} 失敗${failed}`);
if (unmatched.length) console.log('未照合:', unmatched.join(' | '));
