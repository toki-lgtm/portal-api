// 入札案件管理のセットアップ状態を診断する（読み取りのみ・変更しない）
//   実行: cd 04.portal-api && node verify_bids_setup.mjs
import dotenv from 'dotenv'; dotenv.config()
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
if (!url || !key) { console.error('❌ .env に SUPABASE_URL / KEY がありません'); process.exit(1) }
const sb = createClient(url, key)

let ok = true

// 1) テーブル存在チェック
for (const t of ['bid_projects', 'bid_documents', 'bid_status_history']) {
  const { error } = await sb.from(t).select('id', { count: 'exact', head: true })
  if (error) { console.log(`❌ テーブル ${t}: 未作成または不可 (${error.message})`); ok = false }
  else console.log(`✅ テーブル ${t}: OK`)
}

// 2) Storage バケットチェック
const { data: buckets, error: bErr } = await sb.storage.listBuckets()
if (bErr) {
  console.log(`⚠️ バケット一覧の取得に失敗: ${bErr.message}（service_role キーなら取得可）`)
} else {
  const found = (buckets || []).some((b) => b.name === 'bid-documents')
  if (found) console.log('✅ バケット bid-documents: OK')
  else { console.log('❌ バケット bid-documents: 未作成'); ok = false }
}

console.log(ok ? '\n🎉 セットアップ完了。アプリから利用できます。' : '\n→ 上記の❌を 入札案件管理_セットアップ手順.md の手順で解消してください。')
