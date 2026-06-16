-- ============================================================
-- 028: 工事管理 - 数量書ノードに構成比率を付与（別紙明細まで）
-- 実行先: Supabase SQL Editor
--
-- 027 までは構成比率を construction_trade_summary（科目＝工種単位）でのみ保持していた。
-- 本 028 は construction_boq の全ノード（種目/科目/細目/別紙/共通費）に、2種類の
-- 構成比率を数値として保持できるよう列を追加する（表示は変えず、データとして保持）。
--
--   - ratio_total  : 対 直接工事費（全体に占める割合, 0.0〜1.0）。
--                    共通費（積上分）の枝は直接工事費に含まれないため NULL。
--   - ratio_parent : 対 親ノード（その科目/細目の内訳に占める割合, 0.0〜1.0）。
--                    最上位（種目）は対 直接工事費と同義。
--
-- additive（列追加のみ）。再取込で値が埋まる（洗替え）。
-- ============================================================

ALTER TABLE construction_boq ADD COLUMN IF NOT EXISTS ratio_total  NUMERIC;  -- 対 直接工事費
ALTER TABLE construction_boq ADD COLUMN IF NOT EXISTS ratio_parent NUMERIC;  -- 対 親ノード
