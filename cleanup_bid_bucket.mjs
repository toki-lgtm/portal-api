// 入札資料の Drive 移行後、参照されなくなった Supabase Storage(bid-documents) の原本を削除する。
//
// 安全装置:
//   - 実行前に bid_documents.storage_path を全件チェックし、1件でも "drive:" 以外（=まだSupabase参照）が
//     あれば中止する（参照中のファイルを誤って消さないため）。
//   - --dry-run で削除対象（バケット内オブジェクト）の一覧と件数だけ表示。
//
// 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// 使い方:
//   node cleanup_bid_bucket.mjs --dry-run   … 対象確認のみ
//   node cleanup_bid_bucket.mjs             … 実削除

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const DRY = process.argv.includes('--dry-run');
const BUCKET = 'bid-documents';

if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// 1) 安全装置: まだ Supabase 参照の bid_documents が無いか確認
const { data: docs, error: dErr } = await supabase
  .from('bid_documents').select('id, storage_path').not('storage_path', 'is', null);
if (dErr) { console.error('bid_documents 取得失敗:', dErr.message); process.exit(1); }
const stillSupabase = (docs || []).filter((d) => !String(d.storage_path).startsWith('drive:'));
if (stillSupabase.length > 0) {
  console.error(`中止: まだ Supabase 参照の資料が ${stillSupabase.length} 件あります（先に移行を完了してください）。`);
  console.error(stillSupabase.slice(0, 5).map((d) => `  id=${d.id} ${d.storage_path}`).join('\n'));
  process.exit(1);
}
console.log(`安全確認OK: bid_documents ${docs.length} 件すべて drive: 参照（バケット内は孤立ファイル）。`);

// 2) バケットを再帰的に列挙
async function listAll(prefix = '') {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET)
      .list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null || entry.metadata == null) {
        // フォルダ（プレフィックス）→ 再帰
        out.push(...await listAll(path));
      } else {
        out.push(path);
      }
    }
    if (data.length < 100) break;
    offset += data.length;
  }
  return out;
}

const objects = await listAll('');
console.log(`バケット ${BUCKET} のオブジェクト: ${objects.length} 件${DRY ? '  [dry-run]' : ''}`);
for (const p of objects.slice(0, 60)) console.log(`  ${p}`);
if (objects.length > 60) console.log(`  …他 ${objects.length - 60} 件`);

if (DRY) {
  console.log('\n(dry-run — 何も削除していません)');
  process.exit(0);
}

// 3) 100件ずつ削除
let removed = 0;
for (let i = 0; i < objects.length; i += 100) {
  const batch = objects.slice(i, i + 100);
  const { error } = await supabase.storage.from(BUCKET).remove(batch);
  if (error) { console.error('削除失敗:', error.message); process.exit(1); }
  removed += batch.length;
  console.log(`  削除 ${removed}/${objects.length}`);
}
console.log(`\n完了: ${removed} 件削除しました。`);
