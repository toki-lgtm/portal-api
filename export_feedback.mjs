// バグ報告・改善要望を Claude Code 向け Markdown バックログに書き出すスクリプト
//   実行: cd 04.portal-api && node export_feedback.mjs [status]
//     例: node export_feedback.mjs                  → 未対応の3状態(new,triaged,in_progress)
//         node export_feedback.mjs new              → 未対応のみ
//         node export_feedback.mjs new,triaged,done → 任意のステータスをカンマ区切りで
//   出力: ./FEEDBACK_BACKLOG.md（Claude Code に読ませて上から実装していく）
//   前提: migration 019 適用済み・.env に SUPABASE_URL / SERVICE_ROLE(or ANON) KEY
import dotenv from 'dotenv'; dotenv.config()
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)

const APP_LABELS = {
  portal: 'ポータル全般', 'safety-patrol': '安全パトロール', 'employee-list': '社員一覧',
  announcements: 'お知らせ', bids: '入札案件管理', other: 'その他',
}
const STATUS_LABELS = { new: '未対応', triaged: '確認済', in_progress: '対応中', done: '完了', wont_fix: '対応しない' }
const SEVERITY_LABELS = { low: '低', medium: '中', high: '高', critical: '致命的' }
const FREQ_LABELS = { always: '毎回', sometimes: '時々', once: '一度だけ' }
const PRIORITY_LABELS = { low: '低', normal: '通常', high: '高' }

// 1件を Markdown ブロックへ（server.js の feedbackToMarkdown と同体裁）
function toMarkdown(f) {
  const typeIcon = f.type === 'bug' ? '🐞バグ' : '💡改善要望'
  const sev = f.severity ? ` / ${SEVERITY_LABELS[f.severity] || f.severity}` : ''
  const appName = APP_LABELS[f.app_key] || f.app_key || '不明'
  const appLine = f.app_label ? `${appName}（${f.app_label}）` : appName
  const created = f.created_at ? new Date(f.created_at).toLocaleString('ja-JP') : ''
  const reporter = [f.reporter_name, f.reporter_email].filter(Boolean).join(' ')
  const env = [f.screen_info, f.app_version ? `ver ${f.app_version}` : null, f.user_agent].filter(Boolean).join(' / ')
  const lines = []
  lines.push(`## [#${f.id}] ${typeIcon}${sev} — ${f.title}`, '')
  lines.push(`- **対象アプリ**: ${appLine} \`${f.app_key}\``)
  lines.push(`- **状態**: ${STATUS_LABELS[f.status] || f.status} / 優先度: ${PRIORITY_LABELS[f.priority] || f.priority}` +
    (f.frequency ? ` / 頻度: ${FREQ_LABELS[f.frequency] || f.frequency}` : ''))
  lines.push(`- **報告者**: ${reporter || '不明'} / ${created}`)
  if (f.page_url) lines.push(`- **発生ページ**: ${f.page_url}`)
  if (env) lines.push(`- **環境**: ${env}`)
  lines.push('')
  if (f.description) lines.push('**説明**', '', f.description, '')
  if (f.steps) lines.push('**再現手順**', '', f.steps, '')
  if (f.expected) lines.push('**期待する動作**', '', f.expected, '')
  if (f.actual) lines.push('**実際の動作**', '', f.actual, '')
  const shots = Array.isArray(f.screenshot_urls) ? f.screenshot_urls : []
  if (shots.length) { lines.push('**スクリーンショット**', ''); for (const u of shots) lines.push(`- ${u}`); lines.push('') }
  if (f.admin_note) lines.push('**管理メモ / 指示**', '', f.admin_note, '')
  return lines.join('\n')
}

const statuses = (process.argv[2] ? process.argv[2].split(',') : ['new', 'triaged', 'in_progress'])
  .map((s) => s.trim()).filter(Boolean)

const { data, error } = await sb
  .from('feedback')
  .select('*')
  .eq('is_active', true)
  .in('status', statuses)
  .order('created_at', { ascending: true })

if (error) {
  console.error('取得に失敗しました:', error.message)
  console.error('（migration 019 が未適用の可能性があります）')
  process.exit(1)
}

const prRank = { high: 0, normal: 1, low: 2 }
const rows = (data || []).sort((a, b) => (prRank[a.priority] ?? 1) - (prRank[b.priority] ?? 1))

const now = new Date().toLocaleString('ja-JP')
const statusText = statuses.map((s) => STATUS_LABELS[s] || s).join('・') || 'すべて'
const header = [
  '# バグ報告・改善要望 バックログ（Claude Code 向け）',
  '',
  `> 生成日時: ${now}`,
  `> 対象ステータス: ${statusText} ／ 全 ${rows.length} 件`,
  '>',
  '> 各項目を上から順に対応してください。着手時は status を `in_progress`、',
  '> 完了時は `done`（見送りは `wont_fix`）に更新します。',
  '> 更新はポータルの管理画面、または `PATCH /api/feedback/:id` で行えます。',
  '',
  '---',
  '',
].join('\n')

const body = rows.length === 0
  ? '_対象のフィードバックはありません。_\n'
  : rows.map(toMarkdown).join('\n\n---\n\n') + '\n'

writeFileSync('FEEDBACK_BACKLOG.md', header + body, 'utf8')
console.log(`✅ FEEDBACK_BACKLOG.md を生成しました（${rows.length} 件 / 対象: ${statusText}）`)
