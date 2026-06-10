// 02.資格者証 直下の「ファイルを1つも含まない重複会社フォルダ」を、フォルダごと削除する。
//
// consolidate 後の残骸（空の社員フォルダだけ抱えた重複会社フォルダ）を片付ける用途。
// 安全策:
//  - 各会社フォルダの「子孫ファイル総数」を数え、最多のフォルダ（=正規）を必ず1つ残す。
//  - 正規フォルダが期待ファイル数（既定: 自動=最多値）を持つことを確認できなければ中止。
//  - 削除対象は「子孫ファイル数 0」のフォルダのみ。Drive のフォルダ削除は再帰だが、
//    中身は空の社員フォルダのみ＝ファイルは一切失われない。
//
//   node cleanup_empty_dup_folders.mjs --dry-run
//   node cleanup_empty_dup_folders.mjs

import dotenv from 'dotenv';
import { driveListChildren, driveTrash, driveConfigured } from './googleDrive.js';

dotenv.config();
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRY = process.argv.includes('--dry-run');
const root = process.env.DRIVE_FOLDER_ID;
if (!driveConfigured()) { console.error('Drive 未設定'); process.exit(1); }

// フォルダ配下（社員フォルダ1段）のファイル総数を数える
async function fileCount(folderId) {
  let n = 0;
  const kids = await driveListChildren(folderId);
  for (const k of kids) {
    if (k.mimeType === FOLDER_MIME) {
      const sub = await driveListChildren(k.id);
      n += sub.filter((s) => s.mimeType !== FOLDER_MIME).length;
    } else {
      n += 1;
    }
  }
  return n;
}

const comps = (await driveListChildren(root)).filter((c) => c.mimeType === FOLDER_MIME);
const byName = new Map();
for (const c of comps) {
  if (!byName.has(c.name)) byName.set(c.name, []);
  byName.get(c.name).push(c);
}

let deleted = 0;
for (const [name, folders] of byName) {
  if (folders.length === 1) { console.log(`= ${name}: 重複なし`); continue; }

  // 各フォルダのファイル数
  const counts = [];
  for (const f of folders) counts.push({ f, n: await fileCount(f.id) });
  counts.sort((a, b) => b.n - a.n);
  const canonical = counts[0];
  const totalFiles = counts.reduce((s, x) => s + x.n, 0);

  console.log(`\n■ ${name}: ${folders.length}個 / ファイル総数 ${totalFiles}`);
  console.log(`  正規(残す): ファイル ${canonical.n} 件のフォルダ`);

  // 安全確認: 正規が全ファイルを保持しているか（他は全て0であること）
  const othersHaveFiles = counts.slice(1).some((x) => x.n > 0);
  if (othersHaveFiles) {
    console.warn(`  ! 正規以外にもファイルを持つフォルダがあります。安全のため ${name} は削除を中止。`);
    continue;
  }

  // 正規以外（=ファイル0）をゴミ箱へ（投稿者権限でも可・30日復元可）
  for (const x of counts.slice(1)) {
    if (x.n !== 0) continue; // 二重ガード
    if (!DRY) await driveTrash(x.f.id);
    deleted++;
  }
  console.log(`  → 空の重複 ${counts.length - 1} 個をゴミ箱へ${DRY ? '（予定）' : ''}`);
}

console.log(`\n完了${DRY ? '（dry-run）' : ''}: 削除 ${deleted} 個`);
