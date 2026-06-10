// 02.資格者証 直下にできた重複フォルダ（例: 中原建設, 中原建設 が複数）を1つに統合する掃除スクリプト。
//
// 背景: フォルダ自動作成の競合バグで、一括スキャン時に同名の会社フォルダが多数できてしまった。
//       ファイルは Drive 上 fileId で管理されるため、別フォルダへ「移動」しても
//       DB の cert_image_path（drive:<fileId>）は壊れない。本スクリプトはファイルを
//       正規フォルダへ移動し、空になった重複フォルダだけを削除する（中身があるフォルダは削除しない安全策つき）。
//
//   node consolidate_cert_folders.mjs --dry-run   … 何が起きるか表示（変更なし）
//   node consolidate_cert_folders.mjs             … 実行

import dotenv from 'dotenv';
import { driveListChildren, driveMove, driveTrash, ensureFolder, driveConfigured } from './googleDrive.js';

dotenv.config();

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRY = process.argv.includes('--dry-run');
const root = process.env.DRIVE_FOLDER_ID;

if (!driveConfigured()) { console.error('Drive 未設定（GOOGLE_SERVICE_ACCOUNT_* / DRIVE_FOLDER_ID）'); process.exit(1); }

// 空であることを確認してから削除（中身があれば消さない＝データ保護）
async function deleteIfEmpty(id, label) {
  const kids = await driveListChildren(id);
  if (kids.length > 0) { console.warn(`  ! 空でないため削除スキップ: ${label}（残${kids.length}）`); return false; }
  if (!DRY) await driveTrash(id);
  return true;
}

const rootChildren = await driveListChildren(root);
const companyFolders = rootChildren.filter((c) => c.mimeType === FOLDER_MIME);

// 会社名でグルーピング
const byCompany = new Map();
for (const f of companyFolders) {
  if (!byCompany.has(f.name)) byCompany.set(f.name, []);
  byCompany.get(f.name).push(f);
}

let movedFiles = 0, deletedFolders = 0;

for (const [companyName, folders] of byCompany) {
  if (folders.length === 1) { console.log(`= ${companyName}: 重複なし（スキップ）`); continue; }
  const canonicalCompany = folders[0].id;
  console.log(`\n■ ${companyName}: ${folders.length}個 → 1個へ統合`);

  const personCanonical = new Map(); // 社員名 -> 正規の社員フォルダID

  for (const comp of folders) {
    const persons = (await driveListChildren(comp.id)).filter((c) => c.mimeType === FOLDER_MIME);
    for (const pf of persons) {
      // 正規の社員フォルダを決める（正規会社配下に1つ）
      let canonId = personCanonical.get(pf.name);
      if (!canonId) {
        if (comp.id === canonicalCompany) {
          canonId = pf.id; // 正規会社にある既存をそのまま正規採用
        } else {
          canonId = await ensureFolder(pf.name, canonicalCompany);
        }
        personCanonical.set(pf.name, canonId);
      }
      if (pf.id === canonId) continue; // すでに正規＝移動不要

      // 社員フォルダ内のファイルを正規フォルダへ移動
      const files = await driveListChildren(pf.id);
      for (const file of files) {
        if (!DRY) await driveMove(file.id, canonId, pf.id);
        movedFiles++;
        console.log(`  ↪ 移動: ${companyName}/${pf.name}/${file.name}`);
      }
      // 空になった重複社員フォルダを削除
      if (await deleteIfEmpty(pf.id, `${companyName}/${pf.name}`)) deletedFolders++;
    }
    // 重複会社フォルダ（正規以外）が空になったら削除
    if (comp.id !== canonicalCompany) {
      if (await deleteIfEmpty(comp.id, `${companyName}(重複)`)) deletedFolders++;
    }
  }
}

console.log(`\n完了${DRY ? '（dry-run — 変更なし）' : ''}: ファイル移動 ${movedFiles} 件 / フォルダ削除 ${deletedFolders} 個`);
