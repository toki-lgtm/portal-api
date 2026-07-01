-- ============================================================
-- 041: WorkScope 監視・遠隔操作（ハートビート + 命令キュー）
-- 実行先: Supabase SQL Editor
-- 目的:
--   ポータルを WorkScope（PC業務記録ツール）の「監視盤 + 遠隔操作卓」にする。
--   - workscope_devices:  導入端末の台帳。DL時に1台=1行を発行し、
--                         ハッシュ化した端末トークンで本人性を確認する。
--   - workscope_status:   端末ごとの最新ハートビート（生存・Outlook可否・当日件数等）。
--                         端末1台につき1行（device_id で upsert）。
--   - workscope_commands: 管理者→端末への命令キュー（今すぐ送信 / 期間再送 / 点検 等）。
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth / requireAdmin / requireDevice で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS workscope_commands CASCADE;
DROP TABLE IF EXISTS workscope_status   CASCADE;
DROP TABLE IF EXISTS workscope_devices  CASCADE;

-- ── 1) 導入端末の台帳 ─────────────────────────────────────────
--    ポータルからDLするたびに1行発行。token_hash = 端末トークンの SHA-256(hex)。
--    トークン平文はDL時に zip の agent_config.json へ1回だけ埋め込み、以後サーバは保持しない。
CREATE TABLE workscope_devices (
  id            UUID PRIMARY KEY,                    -- 端末ID（= トークンの主体）
  token_hash    TEXT,                                -- 端末トークンの SHA-256(hex)。central監視のみの端末は null
  source        TEXT NOT NULL DEFAULT 'agent',       -- 'agent'（社員PC常駐）/ 'central'（管理PC代理・監視のみ）
  agent_enabled BOOLEAN NOT NULL DEFAULT true,       -- false=遠隔操作不可（エージェント未導入・監視のみ）
  staff_id      TEXT,                                -- staff_master 突合ID（未登録なら null）
  employee_name TEXT,                                -- 表示名（DL時点 / _raw の社員名）
  email         TEXT,                                -- 会社メール（DL時点 / 名前突合）
  hostname      TEXT,                                -- 端末ホスト名（ハートビートで更新）
  version       TEXT,                                -- 稼働中の WorkScope 版（ハートビートで更新）
  revoked       BOOLEAN NOT NULL DEFAULT false,      -- 失効（配布停止・端末退役）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ                          -- 最終ハートビート時刻
);

CREATE INDEX IF NOT EXISTS idx_ws_devices_tokenhash ON workscope_devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_ws_devices_email     ON workscope_devices(email);
CREATE INDEX IF NOT EXISTS idx_ws_devices_lastseen  ON workscope_devices(last_seen_at DESC);

-- ── 2) 端末ごとの最新状態（ハートビート）────────────────────────
--    端末1台につき1行。device_id を主キーにして毎回 upsert する。
CREATE TABLE workscope_status (
  device_id      UUID PRIMARY KEY REFERENCES workscope_devices(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(), -- このハートビートの生成時刻（端末時刻→サーバ受信で更新）
  outlook_ok     BOOLEAN,                            -- 直近の送信処理で Outlook 取得が正常完了したか
  received_today INTEGER,                            -- 当日受信件数（最後に送信した集計値）
  sent_today     INTEGER,                            -- 当日送信件数
  activity_ok    BOOLEAN,                            -- ActivityWatch 応答あり
  keylog_ok      BOOLEAN,                            -- キーロガー常駐プロセス生存
  last_send_at   TIMESTAMPTZ,                        -- 最後に共有ドライブへ送信できた時刻
  last_send_date DATE,                               -- 最後に送信したデータの対象日
  agent_version  TEXT,                               -- ws_agent 側の版
  extra          JSONB                               -- 予備（将来の指標追加用）
);

CREATE INDEX IF NOT EXISTS idx_ws_status_ts ON workscope_status(ts DESC);

-- ── 3) 管理者→端末への命令キュー ──────────────────────────────
--    status: queued（未取得）→ sent（端末が取得）→ done / error（実行結果）。
--    cmd: 'send'（当日送信） / 'resend'（args.date を再送） /
--         'resend_range'（args.from〜args.to を再送） / 'catchup' / 'ping'。
CREATE TABLE workscope_commands (
  id          UUID PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES workscope_devices(id) ON DELETE CASCADE,
  cmd         TEXT NOT NULL,
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'queued',        -- queued / sent / done / error
  result      TEXT,                                  -- 実行結果メッセージ
  created_by  TEXT,                                  -- 発行した管理者のメール
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,                           -- 端末が取得した時刻
  done_at     TIMESTAMPTZ                            -- 実行完了/失敗の時刻
);

CREATE INDEX IF NOT EXISTS idx_ws_cmd_device  ON workscope_commands(device_id, status);
CREATE INDEX IF NOT EXISTS idx_ws_cmd_created ON workscope_commands(created_at DESC);
