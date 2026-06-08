-- ============================================================
-- 011: 資格者証の画像パスを社員資格に追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   資格者証（免許証・修了証カード等）をアップロードして AI で読み取り、
--   元画像を Supabase Storage（qualification-certs バケット）に保存する。
--   その保存先パスを staff_qualifications に持たせ、後から原本を確認できるようにする。
-- ============================================================

ALTER TABLE staff_qualifications
  ADD COLUMN IF NOT EXISTS cert_image_path TEXT; -- qualification-certs バケット内のパス（原本画像）

-- 備考:
--   バケット qualification-certs はアプリ起動時に server.js が自動作成する（非公開）。
--   画像の表示には署名付きURL（有効期限つき）を都度発行する。個人情報を含むため公開しない。
