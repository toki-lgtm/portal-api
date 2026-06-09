-- ============================================================
-- 012: 社内メールアドレスのパスワードを社員台帳に追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内メール（@nakahara131.co.jp）の設定用パスワードを社員ごとに記録する。
--   メールアドレス自体は既存の staff_master.email を使う。
-- 注意（重要・セキュリティ）:
--   メールパスワードは実ログインに使う値のためハッシュ化できず平文で保持する。
--   staff_master は RLS オフのため、anon(publishable) キーがあれば REST 直叩きで読めてしまう。
--   アプリ側では /api/employees が「社員一覧の管理者(admin)」にのみ email_password を返すよう制御している。
--   将来的な堅牢化（staff_master への RLS 有効化＋Express の service_role 化）を別途推奨。
-- ============================================================

ALTER TABLE staff_master
  ADD COLUMN IF NOT EXISTS email_password TEXT; -- 社内メールの設定用パスワード（平文・管理者のみ閲覧）

-- 値の投入（35名分の email / email_password）は、PII を Git に残さないため
-- このマイグレーションには含めず、ローカルから REST(PATCH) で別途投入する。
