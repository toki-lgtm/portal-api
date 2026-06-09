-- ============================================================
-- 013: 共有メールアドレス（部署・拠点・用途で共用するメール）
-- 実行先: Supabase SQL Editor
-- 目的:
--   個人に紐付かない共有メール（対馬本社 / 福岡支社 / 中央産業 / レイワエステート /
--   事務所内 / ログハウス用 等）のアドレスと設定用パスワードを記録・閲覧する。
--   個人台帳 staff_master とは分けて持つ（社員一覧に混在させない）。
-- 注意（セキュリティ）:
--   パスワードは実ログイン用のため平文保持。RLS オフのため anon キー直叩きでは読めてしまう。
--   アプリ側では /api/shared-mailboxes が email_password を「社員一覧の管理者(admin)」にのみ返す。
-- ============================================================

CREATE TABLE IF NOT EXISTS shared_mailboxes (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL,         -- 共有メールアドレス
  label          TEXT,                  -- 用途/拠点名（例: 対馬本社, ログハウス用）
  email_password TEXT,                  -- 設定用パスワード（平文・管理者のみ閲覧）
  sort_order     INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- 値の投入はローカルから REST で行い、PII を Git に残さない。
