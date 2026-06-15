// WorkScope インストーラーzipを Supabase Storage(app-downloads) にアップロードし、
// workscope_release に現行版として1行追加する一回限りスクリプト。
// ポータルの管理者UIと同じ処理を、サービスロールキーで直接実行する。
//   node upload_workscope_release.mjs [zipパス] [バージョン]
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const ZIP = process.argv[2] || 'D:\\WorkScope\\dist\\WorkScope_setup.zip';
const VERSION = process.argv[3] || '2.0.0';
const BUCKET = 'app-downloads';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) { console.error('SUPABASE_URL / SERVICE_ROLE_KEY が未設定'); process.exit(1); }
const supabase = createClient(url, key);

async function main() {
  // 1) バケット確保（非公開）
  const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
  if (bErr) throw bErr;
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error: cErr } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (cErr && !/exist/i.test(cErr.message || '')) throw cErr;
    console.log(`バケット作成: ${BUCKET}`);
  } else {
    console.log(`バケット既存: ${BUCKET}`);
  }

  // 2) アップロード
  const buf = readFileSync(ZIP);
  const path = `workscope/${Date.now()}-WorkScope_setup.zip`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: 'application/zip', upsert: true });
  if (upErr) throw upErr;
  console.log(`アップロード: ${path} (${buf.length} bytes)`);

  // 3) release 行追加（最新＝現行版）
  const { data, error: iErr } = await supabase
    .from('workscope_release')
    .insert({
      version: VERSION,
      file_path: path,
      file_size: buf.length,
      notes: process.argv[4] || null,
      uploaded_by: 'toki@nakahara131.co.jp',
    })
    .select()
    .maybeSingle();
  if (iErr) throw iErr;
  console.log('release 登録:', JSON.stringify(data));

  // 4) 確認: 最新行
  const { data: latest } = await supabase
    .from('workscope_release')
    .select('id, version, file_size, uploaded_at')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log('現行版:', JSON.stringify(latest));
}

main().then(() => { console.log('DONE'); process.exit(0); })
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
