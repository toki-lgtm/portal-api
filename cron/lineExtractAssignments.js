// ============================================================
// 翌日の現場別人員 抽出スクリプト（手動・backfill 用）
//   ★本番の定期実行は server.js 内蔵スケジューラ（毎晩20:00 JST）が担う。
//     Render Cron Job の新規登録は不要。このスクリプトは任意日の再抽出・
//     過去分の埋め戻し（backfill）を手元やワンショットで回すためのもの。
//     例) node cron/lineExtractAssignments.js 2026-07-08
//   server.js を import しない独立スクリプト（Express が起動するため）。
//
// 役割:
//   当日(JST)のグループLINE発言(text)を line_messages から読み、
//   Gemini で「現場ごとの人員」を抽出し、翌営業日ぶんを site_assignments へ
//   洗い替え保存する（管理者が手修正した行 edited=true は保護＝消さない）。
//
// 対象投稿日: 引数 YYYY-MM-DD があればその日、無ければ「本日(JST)」。
//   例) node cron/lineExtractAssignments.js 2026-07-08
// 必要env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY
// ============================================================

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { extractSiteAssignments, nextWorkingDay } from '../siteAssignments.js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { global: { headers: { 'x-client-info': 'portal-api-cron' } }, realtime: { transport: ws } },
);

function sourceDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  const jstMs = Date.now() + 9 * 3600 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10); // 本日(JST)
}

async function main() {
  const src = sourceDate();
  console.log(`[lineExtractAssignments] 開始 投稿日(JST)=${src}`);
  const startZ = new Date(`${src}T00:00:00+09:00`).toISOString();
  const endZ = new Date(`${src}T23:59:59+09:00`).toISOString();

  const { data, error } = await supabase.from('line_messages')
    .select('sent_at, sender_name, message_type, text, group_id, group_name')
    .eq('message_type', 'text')
    .gte('sent_at', startZ).lte('sent_at', endZ)
    .order('sent_at', { ascending: true });
  if (error) { console.error('[lineExtractAssignments] 取得エラー:', error.message); process.exit(1); }
  if (!data.length) { console.log('[lineExtractAssignments] 対象日のtext発言なし。終了。'); process.exit(0); }

  const workDate = await nextWorkingDay(supabase, src);
  console.log(`[lineExtractAssignments] 翌営業日=${workDate}／text発言 ${data.length}件`);

  // グループ単位で抽出（テスト用など人員報告のないグループは自然に0件になる）
  const byGroup = new Map();
  for (const r of data) {
    const key = r.group_name || r.group_id || '未分類';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }

  const rows = [];
  for (const [groupLabel, msgs] of byGroup) {
    let assignments = [];
    try {
      assignments = await extractSiteAssignments(msgs);
    } catch (e) {
      console.error(`[lineExtractAssignments] 抽出失敗(グループ「${groupLabel}」):`, e.message);
      continue;
    }
    for (const a of assignments) {
      // 元発言（報告者の本文）を照合して監査用に保持
      const srcMsg = msgs.find((m) => (m.sender_name || '') === a.source_sender);
      rows.push({
        work_date: workDate,
        site_name: a.site_name,
        work_content: a.work_content || null,
        members: a.members || [],
        member_count: a.member_count || 0,
        group_name: groupLabel,
        source_sender: a.source_sender || null,
        source_date: src,
        raw_text: srcMsg?.text || null,
        edited: false,
      });
    }
    console.log(`[lineExtractAssignments] グループ「${groupLabel}」 → ${assignments.length}現場`);
  }

  // 洗い替え: 対象作業日の未編集行を削除 → 今回ぶんを投入（手修正 edited=true は保護）
  const { error: delErr } = await supabase
    .from('site_assignments')
    .delete()
    .eq('work_date', workDate)
    .eq('edited', false);
  if (delErr) { console.error('[lineExtractAssignments] 削除エラー:', delErr.message); process.exit(1); }

  if (rows.length) {
    const { error: insErr } = await supabase.from('site_assignments').insert(rows);
    if (insErr) { console.error('[lineExtractAssignments] 保存エラー:', insErr.message); process.exit(1); }
  }

  const total = rows.reduce((a, r) => a + (r.member_count || 0), 0);
  console.log(`[lineExtractAssignments] 完了 作業日${workDate}：${rows.length}現場・延べ${total}名を保存`);
  process.exit(0);
}

main().catch((e) => { console.error('[lineExtractAssignments] 予期しないエラー:', e.message); process.exit(1); });
