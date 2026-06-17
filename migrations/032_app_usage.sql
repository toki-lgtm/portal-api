-- ============================================================
-- 032: アプリ使用頻度（アカウント別）
-- 実行先: Supabase SQL Editor
-- 目的: ダッシュボードのアプリ一覧を「ログインユーザーごとの使用頻度の高い順」に
--       並べるため、誰が・どのアプリを・何回・最後にいつ開いたかを記録する。
--       新規テーブルの追加のみ（additive）。既存テーブル・RLS に一切影響しない。
--
--       識別子は user_email（Google OAuth ログイン時のメール小文字、user_settings と同規約）。
--       app_key は /api/apps が返すアプリの key（例: 'safety-patrol','bids' …）。
-- ============================================================

CREATE TABLE IF NOT EXISTS app_usage (
  user_email   text        NOT NULL,
  app_key      text        NOT NULL,
  use_count    integer     NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, app_key)
);

-- ユーザー単位の取得（/api/apps での集計）を高速化
CREATE INDEX IF NOT EXISTS idx_app_usage_user ON app_usage (user_email);
