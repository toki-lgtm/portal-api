// ============================================================
// LINEグループ記録 日次書き出しスクリプト
// Render の Cron Job サービスから1日1回
//   node cron/lineDailyExport.js
// で実行される独立スクリプト。server.js を import しないこと（Express が起動するため）。
//
// 役割:
//   line_messages（一時受け皿）から対象日ぶんを取り出し、
//   グループ(group_name→無ければgroup_id)ごとに構造化CSVを共有ドライブへ保存し、
//   保存できた行を line_messages から削除する（写真の実体はDriveに残る＝CSVから参照可能）。
//
// 対象日: 引数 YYYY-MM-DD があればその日、無ければ「昨日(JST)」（＝確定済みの日を締める）。
//   例) node cron/lineDailyExport.js 2026-07-08
// 必要env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / Drive認証(GOOGLE_SERVICE_ACCOUNT_JSON|FILE)
//          / SHARED_DRIVE_ROOT_ID(未設定なら既定値) / LINE_RECORD_FOLDER_NAME(任意)
// ============================================================

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { driveUpload, ensureFolderPath } from '../googleDrive.js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { global: { headers: { 'x-client-info': 'portal-api-cron' } }, realtime: { transport: ws } }
);

const SHARED_DRIVE_ROOT_ID = process.env.SHARED_DRIVE_ROOT_ID || '0AK5TgtO_Sr4RUk9PVA';
const LINE_RECORD_FOLDER_NAME = process.env.LINE_RECORD_FOLDER_NAME || 'LINEグループ記録';

function sanitizeFolder(s) {
  return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// 共有ドライブ root / LINEグループ記録 / <グループ名> / YYYY-MM
async function groupMonthFolder(groupLabel, ym) {
  const g = sanitizeFolder(groupLabel) || '未分類';
  return ensureFolderPath([LINE_RECORD_FOLDER_NAME, g, ym], SHARED_DRIVE_ROOT_ID);
}

function targetDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  const jstMs = Date.now() + 9 * 3600 * 1000;
  return new Date(jstMs - 24 * 3600 * 1000).toISOString().slice(0, 10); // 昨日(JST)
}

async function main() {
  const d = targetDate();
  console.log(`[lineDailyExport] 開始 対象日(JST)=${d}`);
  const startZ = new Date(`${d}T00:00:00+09:00`).toISOString();
  const endZ = new Date(`${d}T23:59:59+09:00`).toISOString();
  const ym = d.slice(0, 7);

  const { data, error } = await supabase.from('line_messages')
    .select('id, sent_at, sender_name, sender_user_id, event_type, message_type, text, file_name, drive_file_id, group_id, group_name')
    .gte('sent_at', startZ).lte('sent_at', endZ)
    .order('sent_at', { ascending: true });
  if (error) { console.error('[lineDailyExport] 取得エラー:', error.message); process.exit(1); }
  if (!data.length) { console.log('[lineDailyExport] 対象日の発言なし。終了。'); process.exit(0); }

  const esc = (v) => {
    const s = (v ?? '').toString();
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['日時(JST)', 'グループ', '発言者', '種別', '本文', '写真ファイル名', '写真リンク', 'userId', 'groupId'];

  // グループごとに分割
  const byGroup = new Map();
  for (const r of data) {
    const label = r.group_name || r.group_id || '未分類';
    if (!byGroup.has(label)) byGroup.set(label, []);
    byGroup.get(label).push(r);
  }

  for (const [label, rows] of byGroup) {
    const lines = rows.map((r) => {
      const t = r.sent_at
        ? new Date(new Date(r.sent_at).getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : '';
      const link = r.drive_file_id ? `https://drive.google.com/file/d/${r.drive_file_id}/view` : '';
      const kind = r.message_type || r.event_type || '';
      return [t, label, r.sender_name || r.sender_user_id || '', kind, r.text || '', r.file_name || '', link, r.sender_user_id || '', r.group_id || '']
        .map(esc).join(',');
    });
    const csv = '﻿' + [head.join(','), ...lines].join('\r\n') + '\r\n';
    const folderId = await groupMonthFolder(label, ym);
    const fileId = await driveUpload({
      name: `LINEログ_${sanitizeFolder(label) || '未分類'}_${d}.csv`,
      buffer: Buffer.from(csv, 'utf8'),
      mimeType: 'text/csv; charset=utf-8',
      folderId,
    });
    console.log(`[lineDailyExport] グループ「${label}」 ${rows.length}件 → CSV保存 fileId=${fileId}`);
  }

  // 全グループのCSV保存に成功したので、対象行を削除
  const ids = data.map((r) => r.id);
  const { error: delErr } = await supabase.from('line_messages').delete().in('id', ids);
  if (delErr) { console.error('[lineDailyExport] 削除エラー:', delErr.message); process.exit(1); }

  console.log(`[lineDailyExport] 完了 合計${data.length}件を${byGroup.size}グループに書き出し・DBから削除`);
  process.exit(0);
}

main().catch((e) => { console.error('[lineDailyExport] 予期しないエラー:', e.message); process.exit(1); });
