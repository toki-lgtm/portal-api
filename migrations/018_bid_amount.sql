-- ============================================================
-- 018: 入札案件に「入札金額（税抜）」カラムを追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   積算結果の金額と、実際に入札書へ記載する金額を分けて管理する。
--   - our_estimate : 積算金額（ATLUS / Excel 積算データから取り込む。税抜）
--   - bid_amount   : 入札金額（積算金額に係数等をかけた最終応札額。税抜）
--   いずれも「消費税抜き」の金額で統一する（公共工事の入札は税抜で記載するため）。
--
--   ※ 015/017 は本番適用済みのため、破壊せず ADD COLUMN で追記する。
-- ============================================================

ALTER TABLE bid_projects
  ADD COLUMN IF NOT EXISTS bid_amount BIGINT;   -- 入札金額（係数適用後の最終応札額・税抜）

COMMENT ON COLUMN bid_projects.our_estimate IS '積算金額（ATLUS/Excel積算データから取込。税抜・円）';
COMMENT ON COLUMN bid_projects.bid_amount   IS '入札金額（積算金額に係数等を適用した最終応札額。税抜・円）';
