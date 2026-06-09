// テストデータ投入スクリプト（入札案件の一覧/フィルター/分析の確認用）
// created_by = 'seed-test' で識別。削除は cleanup_test_bids.mjs で。
//   実行: cd 04.portal-api && node seed_test_bids.mjs
//   前提: migration 015 適用済み・.env に SUPABASE_URL / SERVICE_ROLE(or ANON) KEY
import dotenv from 'dotenv'; dotenv.config()
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)

const { data: staff } = await sb.from('staff_master').select('id,name').order('id')
if (!staff || staff.length === 0) {
  console.error('staff_master が空です。先に社員データを投入してください。')
  process.exit(1)
}

const pick = (arr, i) => arr[i % arr.length]
const pad = (n) => String(n).padStart(2, '0')
const d = (m, day) => `2026-${pad(m)}-${pad(day)}`
// 今日基準（期限間近・今月入札の確認用に近接日も用意）
const today = new Date()
const future = (days) => {
  const t = new Date(today); t.setDate(t.getDate() + days)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

const clients = ['県土木事務所', '○○市', '△△町', '国交省地方整備局', '××市上下水道局']
const works = ['道路', '橋梁', '舗装', '河川', '上下水道', '造成']
const methods = ['一般競争', '指名競争', '随意契約']

// status 分布: 進行中(collecting/judging/estimating/bid)＋確定(won/lost/contracted/declined)
// 落札率・金額分析が意味を持つよう won/lost/contracted を多めに
const rows = [
  // 進行中（期限間近・今月入札を含む）
  { project_name: 'TEST 国道○○号 道路改良工事', status: 'estimating', bid_date: future(3),  work_type: '道路', budget_price: 85000000, our_estimate: 81000000 },
  { project_name: 'TEST △△橋 橋梁補修工事',     status: 'judging',    bid_date: future(6),  work_type: '橋梁' },
  { project_name: 'TEST 市道□□線 舗装工事',     status: 'collecting', bid_date: future(20), work_type: '舗装' },
  { project_name: 'TEST ○○川 護岸工事',         status: 'bid',        bid_date: future(-2), work_type: '河川', budget_price: 120000000, our_estimate: 116000000 },
  { project_name: 'TEST ××浄水場 設備更新',     status: 'estimating', bid_date: future(1),  work_type: '上下水道', budget_price: 64000000, our_estimate: 60000000 },
  // 落札（予定価格・落札額あり＝応札率算出対象）
  { project_name: 'TEST 県道△△号 改良工事',     status: 'won',        bid_date: d(5, 12), work_type: '道路',   budget_price: 98000000,  our_estimate: 95000000,  awarded_price: 95800000,  awarded_company: '自社' },
  { project_name: 'TEST ○○団地 造成工事',       status: 'won',        bid_date: d(4, 18), work_type: '造成',   budget_price: 150000000, our_estimate: 142000000, awarded_price: 144000000, awarded_company: '自社' },
  { project_name: 'TEST 市道◇◇線 舗装補修',     status: 'contracted', bid_date: d(5, 2),  work_type: '舗装',   budget_price: 42000000,  our_estimate: 39500000,  awarded_price: 40100000,  awarded_company: '自社' },
  { project_name: 'TEST □□川 河川改修工事',     status: 'won',        bid_date: d(6, 1),  work_type: '河川',   budget_price: 73000000,  our_estimate: 70000000,  awarded_price: 71200000,  awarded_company: '自社' },
  // 失注（自社見積あり・落札業者は他社）
  { project_name: 'TEST 国道◎◎号 拡幅工事',     status: 'lost',       bid_date: d(5, 20), work_type: '道路',   budget_price: 210000000, our_estimate: 205000000, awarded_price: 198000000, awarded_company: '△△建設' },
  { project_name: 'TEST ▽▽橋 耐震補強工事',     status: 'lost',       bid_date: d(4, 25), work_type: '橋梁',   budget_price: 88000000,  our_estimate: 86000000,  awarded_price: 82000000,  awarded_company: '○○組' },
  { project_name: 'TEST 市道◆◆線 側溝整備',     status: 'lost',       bid_date: d(6, 5),  work_type: '舗装',   budget_price: 31000000,  our_estimate: 30500000,  awarded_price: 29800000,  awarded_company: '□□工業' },
  // 不参加
  { project_name: 'TEST 山間部 法面工事',         status: 'declined',   bid_date: d(3, 14), work_type: '造成' },
]

const toInsert = rows.map((r, i) => ({
  client_name: pick(clients, i),
  bid_method: pick(methods, i),
  location: `${pick(clients, i)}管内`,
  staff_id: pick(staff, i).id,
  notice_date: r.bid_date ? d(Math.max(1, Number(r.bid_date.slice(5, 7)) - 1), 10) : null,
  note: 'TESTDATA: seed_test_bids で投入',
  created_by: 'seed-test',
  ...r,
}))

const { data, error } = await sb.from('bid_projects').insert(toInsert).select('id, status')
if (error) { console.error('bid_projects insert error:', error.message); process.exit(1) }
console.log(`✅ bid_projects: ${data.length} 件挿入`)

// 初期ステータス履歴も入れておく
const hist = data.map((b) => ({ bid_id: b.id, from_status: null, to_status: b.status, changed_by: 'seed-test' }))
await sb.from('bid_status_history').insert(hist)

const summary = rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {})
console.log('ステータス分布:', JSON.stringify(summary))
console.log('→ 分析タブで 落札率(件数/金額)・平均応札率・発注者別 が確認できます。')
