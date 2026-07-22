// ============================================================
// 入札公告 日次収集スクリプト（standalone / Cron 用）
//
// 実行:
//   node cron/collectBidNotices.js
//
// ローカルの Windows タスクスケジューラから毎日1回実行する想定。
// （九州防衛局のサイトは Node の TLS 指紋を 403 で弾くため curl を使う。
//   curl が使えるローカル環境で走らせるのが確実。ニュースダイジェストと同じ方式。）
//
// server.js は import しないこと（Express が起動してしまうため）。
// 新着があれば入札担当者へ要約メールを送る（SMTP 未設定時はメールのみスキップ）。
// ============================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
// cwd に依存せず、このファイルの1つ上（portal-api ルート）の .env を読む
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
import { runCollection } from '../bidNoticeCollector.js';

const started = Date.now();
console.log(`[入札公告収集] 開始 ${new Date().toISOString()}`);

try {
  const res = await runCollection({ dryRun: false, sendEmail: true });
  console.log(`[入札公告収集] 完了 総取得=${res.totalFound} 新着=${res.totalNew} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const [k, v] of Object.entries(res.perSource)) {
    console.log(`  - ${k}: 取得${v.found} 新着${v.new} ${v.ok ? 'OK' : '失敗:' + (v.error || '')}`);
  }
  if (res.mail) console.log('  - mail:', JSON.stringify(res.mail));
  process.exitCode = 0;
} catch (e) {
  console.error('[入札公告収集] 異常終了:', e.message);
  process.exitCode = 1;
}
// process.exit() は呼ばない（Windows で realtime(ws) ハンドルが libuv アボートを
// 起こすため）。runCollection 内で realtime を切断済みなので、イベントループが
// 空になれば自然終了する。万一ハングしてもタスクの実行時間上限(15分)が backstop。
