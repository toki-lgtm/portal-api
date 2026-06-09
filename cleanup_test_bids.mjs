// テストデータ削除（created_by = 'seed-test' の入札案件を削除）
//   実行: cd 04.portal-api && node cleanup_test_bids.mjs
//   bid_documents / bid_status_history は ON DELETE CASCADE で連動削除
import dotenv from 'dotenv'; dotenv.config()
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)

const { data: rows } = await sb.from('bid_projects').select('id').eq('created_by', 'seed-test')
const ids = (rows || []).map((r) => r.id)
if (!ids.length) { console.log('削除対象のテストデータはありません'); process.exit(0) }

const { error } = await sb.from('bid_projects').delete().eq('created_by', 'seed-test')
if (error) { console.error('削除エラー:', error.message); process.exit(1) }
console.log(`🗑️  テスト入札案件 ${ids.length} 件を削除しました`)
