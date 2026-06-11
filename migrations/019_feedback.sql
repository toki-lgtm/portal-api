-- ============================================================
-- 019: バグ報告・改善要望（フィードバック）機能
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内ポータルに「バグ報告 / 改善要望」を収集する窓口を追加する。
--   収集データは Claude Code が後で実装に着手しやすいよう、再現手順・
--   期待動作・実際の動作・発生環境などを構造化して保持する。
--   - feedback: 報告本体（種別 / 対象アプリ / 内容 / 再現情報 / 環境 / 状態）
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth / 権限解決で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS feedback CASCADE;

-- ── フィードバック本体 ─────────────────────────────────────────
CREATE TABLE feedback (
  id              BIGSERIAL PRIMARY KEY,

  -- 分類
  type            TEXT NOT NULL DEFAULT 'bug'
                  CHECK (type IN ('bug', 'improvement')),          -- バグ報告 / 改善要望
  title           TEXT NOT NULL,                                    -- 一行サマリ
  app_key         TEXT NOT NULL DEFAULT 'portal',                   -- 対象アプリ識別子（portal/safety-patrol/employee-list/announcements/bids/other）
  app_label       TEXT,                                             -- app_key='other' 等の自由記述

  -- 内容（Claude Code が実装着手に使う構造化フィールド）
  description     TEXT,                                             -- 何が起きたか / どうしたいか（自由記述）
  steps           TEXT,                                             -- バグ: 再現手順
  expected        TEXT,                                             -- バグ: 期待する動作 / 要望: あるべき姿
  actual          TEXT,                                             -- バグ: 実際の動作

  -- トリアージ
  severity        TEXT
                  CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),  -- バグの深刻度
  frequency       TEXT
                  CHECK (frequency IS NULL OR frequency IN ('always', 'sometimes', 'once')),       -- 発生頻度
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high')),    -- 管理者が付与する優先度
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'triaged', 'in_progress', 'done', 'wont_fix')),

  -- 発生環境（クライアントで自動取得）
  page_url        TEXT,                                             -- 発生時のURL
  user_agent      TEXT,                                             -- ブラウザ情報
  screen_info     TEXT,                                             -- 画面/ビューポートサイズ等
  app_version     TEXT,                                             -- アプリのバージョン（取得できれば）

  -- 添付
  screenshot_urls JSONB NOT NULL DEFAULT '[]'::JSONB,               -- スクリーンショットURL配列

  -- 報告者
  reporter_email  TEXT,
  reporter_name   TEXT,

  -- 対応記録
  admin_note      TEXT,                                             -- 管理者メモ / Claude Code への指示
  resolution_note TEXT,                                             -- 対応内容（done/wont_fix 時）

  is_active       BOOLEAN NOT NULL DEFAULT TRUE,                    -- 論理削除フラグ
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_status   ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_type     ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_app_key  ON feedback(app_key);
CREATE INDEX IF NOT EXISTS idx_feedback_reporter ON feedback(reporter_email);
CREATE INDEX IF NOT EXISTS idx_feedback_created  ON feedback(created_at DESC);

-- ── 権限付与（任意）─────────────────────────────────────────────
-- 投稿・自分の報告閲覧は全社員が可能（アプリ側で requireAuth のみ）。
-- 全件閲覧・トリアージ・エクスポートは「グローバル管理者」か
-- staff_app_permissions['feedback'].access_level='admin' の社員に許可される。
-- 必要に応じて下記のように権限を付与する（例: DX担当を feedback 管理者にする）:
--   INSERT INTO staff_app_permissions (staff_id, app_key, access_level)
--   SELECT id, 'feedback', 'admin' FROM staff_master WHERE email = 'toki@nakahara131.co.jp'
--   ON CONFLICT (staff_id, app_key) DO UPDATE SET access_level = EXCLUDED.access_level;
