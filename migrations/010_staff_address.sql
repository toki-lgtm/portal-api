-- ============================================================
-- 010: staff_master に住所（address）/ 郵便番号（postal_code）列を追加
-- 実行先: Supabase SQL Editor
-- 目的: 社員一覧で住所を保持・表示するため。作業員名簿CSVの「住所」「郵便番号」を取り込む。
-- ============================================================

ALTER TABLE staff_master
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS address     TEXT;
