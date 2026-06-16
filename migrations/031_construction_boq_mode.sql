-- ============================================================
-- 031: 工事管理 - 設計変更 BOQ 取込モード拡張
-- 実行先: Supabase SQL Editor
-- 目的:
--   設計変更数量書には「全体版（変更後の完全な数量書）」と
--   「変更分のみ版（delta: 増減明細のみ）」の 2 種類がある。
--   取込時にどちらで保存したかを記録し、
--   「変更後」の集計を正しく解決できるようにする。
--
--   construction_design_changes に 3 列を additive で追加するのみ。
--   既存テーブル・インデックス・RLS に一切影響しない。
-- ============================================================

-- ── 1) 取込モード列（NULL=数量書未取込 / 'full'=全体版 / 'delta'=変更分のみ）
ALTER TABLE construction_design_changes
  ADD COLUMN IF NOT EXISTS boq_mode TEXT
    CHECK (boq_mode IN ('full', 'delta'));

-- ── 2) 変更版数量書の直接工事費合計（full=変更後合計 / delta=増減合計 / NULL=未取込）
ALTER TABLE construction_design_changes
  ADD COLUMN IF NOT EXISTS boq_total NUMERIC;

-- ── 3) 数量書取込日時
ALTER TABLE construction_design_changes
  ADD COLUMN IF NOT EXISTS boq_imported_at TIMESTAMPTZ;
