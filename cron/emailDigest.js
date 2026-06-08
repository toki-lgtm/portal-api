// ============================================================
// メール日次ダイジェスト送信スクリプト
// Render の Cron Job サービスから毎時 0 分に
//   node cron/emailDigest.js
// で実行される独立スクリプト。server.js を import しないこと（Express が起動してしまうため）。
// ============================================================

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

dotenv.config();

// ── Supabase クライアント（env 変数名は server.js と完全一致）──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { global: { headers: { 'x-client-info': 'portal-api-cron' } } }
);

// ── nodemailer transporter（env 変数名は server.js と完全一致）──
const MAIL_FROM = process.env.MAIL_FROM || 'system_noreply@nakahara131.co.jp';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '中原建設社内システム';
const PORTAL_URL = 'https://portal-app-beryl.vercel.app';

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('メール送信が未設定です（環境変数 SMTP_HOST / SMTP_USER / SMTP_PASS を設定してください）');
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 は暗黙SSL。587 は STARTTLS（日和見的に使用）
    auth: { user, pass },
    requireTLS: false,                 // サーバー設定が「暗号化なし」のためTLSを必須にしない
    tls: { rejectUnauthorized: false } // 暗号化なし／自己署名環境でも送信を通す
  });
}

// ── JST の現在時刻から weekday(0-6) と hour(0-23) を求める ──
//    Render は UTC で動作するため、Date.now() + 9h の UTC getter を使う。
function getJstWeekdayAndHour() {
  const jstMs = Date.now() + 9 * 3600 * 1000;
  const jstDate = new Date(jstMs);
  const weekday = jstDate.getUTCDay();  // 0=日,1=月,…,6=土（JST の曜日）
  const hour = jstDate.getUTCHours();   // JST の時刻（0〜23）
  return { weekday, hour };
}

// ── /api/dashboard/stats と同じ集計ロジック ──
//    awaiting_approval: status='submitted' の点検数
//    issues_open: 指摘あり明細のうち未承認（approved 以外）の件数
async function fetchStats() {
  // 点検一覧
  const { data: inspRows, error: inspErr } = await supabase
    .from('inspections')
    .select('id, status');
  if (inspErr) throw inspErr;
  const inspections = inspRows || [];

  // 承認待ち: inspection の status が 'submitted'
  const awaitingApproval = inspections.filter((i) => i.status === 'submitted').length;

  // 指摘明細（是正状態の集計用）
  const { data: detRows, error: detErr } = await supabase
    .from('inspection_details')
    .select('correction_status')
    .eq('result', '指摘あり');
  if (detErr) throw detErr;
  const details = detRows || [];

  let issuesOpen = 0;
  for (const d of details) {
    const cs = d.correction_status || 'pending';
    if (cs !== 'approved') issuesOpen++;
  }

  return { awaitingApproval, issuesOpen };
}

// ── メール本文を生成（HTML ＋ テキスト）──
function buildMailContent({ awaitingApproval, issuesOpen }) {
  const text = [
    'お疲れ様です。中原建設社内ポータルです。',
    '',
    '本日の未処理タスクをお知らせします。',
    '',
    `　承認待ち　　　： ${awaitingApproval} 件`,
    `　是正対応中　　： ${issuesOpen} 件`,
    '',
    `ポータルにアクセスして確認・対応してください。`,
    `　${PORTAL_URL}`,
    '',
    '────────────────────',
    '※本メールは送信専用アドレスから自動送信されています。',
    '※ご返信いただいてもご対応できない場合があります。',
  ].join('\n');

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family: sans-serif; color: #333;">
  <p>お疲れ様です。中原建設社内ポータルです。</p>
  <p>本日の未処理タスクをお知らせします。</p>
  <table style="border-collapse: collapse; margin: 1em 0;">
    <tr>
      <td style="padding: 4px 16px 4px 0;">承認待ち</td>
      <td style="padding: 4px 0; font-weight: bold;">${awaitingApproval} 件</td>
    </tr>
    <tr>
      <td style="padding: 4px 16px 4px 0;">是正対応中</td>
      <td style="padding: 4px 0; font-weight: bold;">${issuesOpen} 件</td>
    </tr>
  </table>
  <p>
    ポータルにアクセスして確認・対応してください。<br>
    <a href="${PORTAL_URL}">${PORTAL_URL}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #ccc; margin: 1.5em 0;">
  <p style="font-size: 12px; color: #888;">
    ※本メールは送信専用アドレスから自動送信されています。<br>
    ※ご返信いただいてもご対応できない場合があります。
  </p>
</body>
</html>
`.trim();

  return { text, html };
}

// ── メイン処理 ──
async function main() {
  console.log(`[emailDigest] 開始 ${new Date().toISOString()}`);

  const { weekday, hour } = getJstWeekdayAndHour();
  console.log(`[emailDigest] JST weekday=${weekday} hour=${hour}`);

  // email_enabled=true の設定レコードを取得
  // Supabase PostgREST で JSONB のブール値を比較: ->> でテキスト化して 'true' と比較
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('user_settings')
    .select('user_email, settings')
    .eq(`settings->notifications->>email_enabled`, 'true');

  if (settingsErr) {
    console.error('[emailDigest] user_settings 取得エラー:', settingsErr.message);
    process.exit(1);
  }

  const allRows = settingsRows || [];
  console.log(`[emailDigest] email_enabled=true のユーザー数: ${allRows.length}`);

  // 今日の weekday・hour に一致するユーザーを抽出
  const targets = allRows.filter((row) => {
    const notif = row.settings?.notifications || {};
    const weekdays = Array.isArray(notif.email_weekdays) ? notif.email_weekdays : [1, 2, 3, 4, 5];
    const emailHour = Number(notif.email_hour ?? 8);
    return weekdays.includes(weekday) && emailHour === hour;
  });

  console.log(`[emailDigest] 本時刻対象ユーザー数: ${targets.length}`);

  if (targets.length === 0) {
    console.log('[emailDigest] 送信対象なし。終了。');
    process.exit(0);
  }

  // 未処理件数を共通取得（全ユーザー共通の集計値）
  let stats;
  try {
    stats = await fetchStats();
    console.log(`[emailDigest] 集計結果: awaiting_approval=${stats.awaitingApproval} issues_open=${stats.issuesOpen}`);
  } catch (e) {
    console.error('[emailDigest] 集計エラー:', e.message);
    process.exit(1);
  }

  // 両方 0 の場合は全員スキップ
  if (stats.awaitingApproval === 0 && stats.issuesOpen === 0) {
    console.log('[emailDigest] 未処理タスクなし（承認待ち・是正対応中ともに0件）。送信をスキップ。');
    process.exit(0);
  }

  // transporter 生成
  let transporter;
  try {
    transporter = createTransporter();
  } catch (e) {
    console.error('[emailDigest] transporter 生成エラー:', e.message);
    process.exit(1);
  }

  const { text, html } = buildMailContent(stats);
  const subject = '【社内ポータル】本日の未処理タスクのお知らせ';

  let successCount = 0;
  let failCount = 0;

  for (const row of targets) {
    try {
      await transporter.sendMail({
        from: { name: MAIL_FROM_NAME, address: MAIL_FROM },
        to: row.user_email,
        subject,
        text,
        html,
      });
      console.log(`[emailDigest] 送信成功: ${row.user_email}`);
      successCount++;
    } catch (e) {
      console.error(`[emailDigest] 送信失敗: ${row.user_email} - ${e.message}`);
      failCount++;
    }
  }

  console.log(`[emailDigest] 完了 - 成功: ${successCount} 件 / 失敗: ${failCount} 件`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[emailDigest] 予期しないエラー:', e.message);
  process.exit(1);
});
