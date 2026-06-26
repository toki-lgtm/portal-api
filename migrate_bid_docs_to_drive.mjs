// 既存の入札案件資料を Supabase Storage から Google 共有ドライブへ移行するスクリプト。
//
// bid_documents.storage_path のうち、まだ Supabase 保存（"drive:" で始まらない）の
// レコードを対象に、Supabase からダウンロード → Drive（入札案件/<案件名>/）へアップロード →
// storage_path を "drive:<fileId>" に書き換える。
//
// ・冪等: すでに "drive:" のものはスキップ。途中で止めても再実行で続きから。
// ・安全: Supabase 側の元ファイルは削除しない（バックアップとして残す）。
//
// 必要な環境変数（.env か実行時環境に）:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_SERVICE_ACCOUNT_JSON（または GOOGLE_SERVICE_ACCOUNT_FILE） / DRIVE_FOLDER_ID
//
// 使い方:
//   node migrate_bid_docs_to_drive.mjs --dry-run   … 件数と対象を確認するだけ（書き換えなし）
//   node migrate_bid_docs_to_drive.mjs             … 実際に移行する

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { driveUpload, driveConfigured, ensureFolderPath } from './googleDrive.js';

dotenv.config();

function sanitizeSeg(s) {
  const v = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return v || '未設定';
}

const DRY = process.argv.includes('--dry-run');
const BUCKET = 'bid-documents';

if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  process.exit(1);
}
if (!driveConfigured()) {
  console.error('GOOGLE_SERVICE_ACCOUNT_JSON / DRIVE_FOLDER_ID が未設定です。DRIVE_SETUP.md の手順を先に完了してください。');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

function guessMime(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
    zip: 'application/zip', csv: 'text/csv', txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

const { data: rows, error } = await supabase
  .from('bid_documents')
  .select('id, storage_path, file_name, bid_id')
  .not('storage_path', 'is', null);
if (error) {
  console.error('bid_documents の取得に失敗:', error.message);
  process.exit(1);
}

// 案件ID→工事名（Drive のサブフォルダ振り分け用）
const { data: bidRows } = await supabase.from('bid_projects').select('id, project_name');
const bidById = new Map((bidRows || []).map((b) => [b.id, b]));

const targets = rows.filter((r) => r.storage_path && !String(r.storage_path).startsWith('drive:'));
console.log(`入札資料: 全 ${rows.length} 件中、移行対象（Supabase保存）= ${targets.length} 件${DRY ? '  [dry-run]' : ''}`);

let ok = 0;
let fail = 0;
for (const r of targets) {
  try {
    const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(r.storage_path);
    if (dlErr) throw dlErr;
    const buffer = Buffer.from(await blob.arrayBuffer());
    const mimeType = blob.type && blob.type !== 'application/octet-stream' ? blob.type : guessMime(r.file_name || r.storage_path);

    const bid = bidById.get(r.bid_id);
    const segments = ['入札案件', sanitizeSeg(bid?.project_name)];
    const name = r.file_name || String(r.storage_path).split('/').pop();

    if (DRY) {
      console.log(`[dry] id=${r.id}  ${r.storage_path} -> ${segments.join('/')}/${name}  (${buffer.length} bytes, ${mimeType})`);
      ok++;
      continue;
    }

    const folderId = await ensureFolderPath(segments);
    const fileId = await driveUpload({ name, buffer, mimeType, folderId });
    const { error: upErr } = await supabase
      .from('bid_documents')
      .update({ storage_path: `drive:${fileId}` })
      .eq('id', r.id);
    if (upErr) throw upErr;

    console.log(`OK   id=${r.id}  ${name} -> drive:${fileId}`);
    ok++;
  } catch (e) {
    console.error(`FAIL id=${r.id}  ${r.storage_path}: ${e.message}`);
    fail++;
  }
}

console.log(`\n完了: 成功 ${ok} 件 / 失敗 ${fail} 件${DRY ? '  (dry-run — 何も変更していません)' : ''}`);
console.log('※ Supabase 側の元ファイルは残しています。表示確認後、不要なら手動で削除してください。');
