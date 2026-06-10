// 既存の資格者証ファイルを Supabase Storage から Google 共有ドライブへ移行するスクリプト。
//
// staff_qualifications.cert_image_path のうち、まだ Supabase 保存（"drive:" で始まらない）の
// レコードを対象に、Supabase からファイルをダウンロード → Drive へアップロード →
// cert_image_path を "drive:<fileId>" に書き換える。
//
// ・冪等: すでに "drive:" のものはスキップ。途中で止めても再実行で続きから。
// ・安全: Supabase 側の元ファイルは削除しない（バックアップとして残す）。
//
// 必要な環境変数（.env か実行時環境に）:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（読み書きのため service role 推奨）
//   GOOGLE_SERVICE_ACCOUNT_JSON / DRIVE_FOLDER_ID（DRIVE_SETUP.md で用意したもの）
//
// 使い方:
//   node migrate_certs_to_drive.mjs --dry-run   … 件数と対象を確認するだけ（書き換えなし）
//   node migrate_certs_to_drive.mjs             … 実際に移行する

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { driveUpload, driveConfigured, ensureFolderPath } from './googleDrive.js';

dotenv.config();

function sanitizeSeg(s) {
  const v = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return v || '_未分類';
}
function certFolderSegments(staff) {
  const company = (staff && staff.company ? String(staff.company).trim() : '') || '会社未設定';
  const name = (staff && staff.name ? String(staff.name).trim() : '') || '_未分類';
  return [sanitizeSeg(company), sanitizeSeg(name)];
}

const DRY = process.argv.includes('--dry-run');
const BUCKET = 'qualification-certs';

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
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

const { data: rows, error } = await supabase
  .from('staff_qualifications')
  .select('id, cert_image_path, staff_id')
  .not('cert_image_path', 'is', null);
if (error) {
  console.error('staff_qualifications の取得に失敗:', error.message);
  process.exit(1);
}

// 社員ID→会社/氏名 の対応表（Drive のサブフォルダ振り分け用）
const { data: staffRows } = await supabase.from('staff_master').select('id, name, company');
const staffById = new Map((staffRows || []).map((s) => [s.id, s]));

const targets = rows.filter((r) => r.cert_image_path && !String(r.cert_image_path).startsWith('drive:'));
console.log(`資格者証ファイル: 全 ${rows.length} 件中、移行対象（Supabase保存）= ${targets.length} 件${DRY ? '  [dry-run]' : ''}`);

let ok = 0;
let fail = 0;
for (const r of targets) {
  try {
    const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(r.cert_image_path);
    if (dlErr) throw dlErr;
    const buffer = Buffer.from(await blob.arrayBuffer());
    const mimeType = blob.type && blob.type !== 'application/octet-stream' ? blob.type : guessMime(r.cert_image_path);

    const segments = certFolderSegments(staffById.get(r.staff_id));

    if (DRY) {
      console.log(`[dry] id=${r.id}  ${r.cert_image_path} -> ${segments.join('/')}/  (${buffer.length} bytes, ${mimeType})`);
      ok++;
      continue;
    }

    const folderId = await ensureFolderPath(segments);
    const name = String(r.cert_image_path).split('/').pop();
    const fileId = await driveUpload({ name, buffer, mimeType, folderId });
    const { error: upErr } = await supabase
      .from('staff_qualifications')
      .update({ cert_image_path: `drive:${fileId}` })
      .eq('id', r.id);
    if (upErr) throw upErr;

    console.log(`OK   id=${r.id}  ${r.cert_image_path} -> drive:${fileId}`);
    ok++;
  } catch (e) {
    console.error(`FAIL id=${r.id}  ${r.cert_image_path}: ${e.message}`);
    fail++;
  }
}

console.log(`\n完了: 成功 ${ok} 件 / 失敗 ${fail} 件${DRY ? '  (dry-run — 何も変更していません)' : ''}`);
console.log('※ Supabase 側の元ファイルは残しています。表示確認後、不要なら手動で削除してください。');
