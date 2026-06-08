-- ============================================================
-- 006: 社員の権限（管理者 / メンバー）
-- 実行先: Supabase SQL Editor
-- 目的: 安全パトロールの権限制御。
--       app_role = 'admin'（管理者：全機能） / 'member'（メンバー：一覧閲覧・新規点検）
--       既定は member。管理者は環境変数 ADMIN_EMAILS でも指定可能（多層）。
-- ============================================================

ALTER TABLE staff_master
  ADD COLUMN IF NOT EXISTS app_role TEXT NOT NULL DEFAULT 'member';

-- 初期管理者（メールが staff_master に登録済みの場合のみ反映。未登録でも環境変数側で管理者化される）
UPDATE staff_master
  SET app_role = 'admin'
  WHERE lower(email) = 'toki@nakahara131.co.jp';
