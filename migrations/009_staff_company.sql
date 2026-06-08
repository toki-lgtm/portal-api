-- ============================================================
-- 009: staff_master に会社（company）列を追加
-- 実行先: Supabase SQL Editor
-- 目的: グループ会社（中原建設 / 中央産業 など）を社員ごとに保持する。
--       部署(department)とは別軸の「所属会社」。社員一覧の表示・絞り込みに使用。
-- あわせて updated_at を保証（社員更新APIが更新日時を書き込むため）。
-- ============================================================

ALTER TABLE staff_master
  ADD COLUMN IF NOT EXISTS company    TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
