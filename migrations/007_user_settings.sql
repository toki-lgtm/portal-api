-- ============================================================
-- 007: 個人設定テーブル
-- 実行先: Supabase SQL Editor
-- 目的: ユーザーごとのポータル設定（アプリ固定表示・通知設定）を保存する。
--       主キーは user_email（Google OAuth ログイン時のメールアドレス小文字）。
--       settings カラムは JSONB で、後方互換のためサーバー側でデフォルト補完する。
-- ============================================================

CREATE TABLE IF NOT EXISTS user_settings (
  user_email text PRIMARY KEY,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
