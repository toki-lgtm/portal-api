// ============================================================
// 検査書類チェックリスト AI棚卸し（日次）
// Render の Cron Job サービスから 1日1回（例: 毎日 JST 6:00）
//   node cron/inspectionSweep.js
// で実行される独立スクリプト。server.js を import せず、
// 本番APIの /api/construction/inspection-sweep-all を叩くだけ（AI判定はAPI側）。
//
// 必要な環境変数:
//   PUBLIC_API_URL : 本番APIのベースURL（未設定時は Render の既定URLを使用）
//   CRON_KEY       : sweep-all 認証キー（server.js と同じ値）
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.PUBLIC_API_URL || 'https://portal-api-hhlx.onrender.com';
const CRON_KEY = process.env.CRON_KEY;

async function main() {
  console.log(`[inspectionSweep] 開始 ${new Date().toISOString()}`);
  if (!CRON_KEY) {
    console.error('[inspectionSweep] CRON_KEY が未設定です。終了。');
    process.exit(1);
  }
  try {
    const resp = await fetch(`${BASE}/api/construction/inspection-sweep-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-key': CRON_KEY },
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[inspectionSweep] APIエラー ${resp.status}: ${text.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`[inspectionSweep] 完了: ${text}`);
    process.exit(0);
  } catch (e) {
    console.error('[inspectionSweep] 予期しないエラー:', e.message);
    process.exit(1);
  }
}

main();
