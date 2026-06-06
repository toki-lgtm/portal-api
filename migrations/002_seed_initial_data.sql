-- 部門の初期データ
INSERT INTO public.departments (name, description) VALUES
  ('経営管理', '経営・管理部門'),
  ('施工', '施工部門'),
  ('営業', '営業・企画部門'),
  ('技術', '技術・設計部門')
ON CONFLICT (name) DO NOTHING;

-- 注意：ユーザーデータは auth.users から自動同期されるため、
-- ここでは初期データは挿入しません。
-- ユーザーが Google OAuth でログインすると、
-- ユーザーテーブルに自動で行が作成される仕様にします。
