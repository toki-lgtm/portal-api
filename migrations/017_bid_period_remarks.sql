-- ============================================================
-- 017: 入札案件に「札入れ期間」と通知書の備考・理由を追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   指名通知書には「入札書の提出」に期間が設定される案件がある
--   （入札開始日時 〜 入札書提出締切日時）。これを表現できるよう
--   開始日カラムを追加し、既存の bid_date を「入札締切日」として扱う。
--   併せて通知書記載の「備考」「理由」を保存する欄を追加する。
--   （既存の note は社内向け自由メモのため、転記用に別カラムを用意）
--
--   ※ 015 は本番適用済みのため、破壊せず ADD COLUMN で追記する。
-- ============================================================

ALTER TABLE bid_projects
  ADD COLUMN IF NOT EXISTS bid_start_date DATE,   -- 入札開始日（札入れ期間の開始。単日入札では空）
  ADD COLUMN IF NOT EXISTS remarks        TEXT,   -- 備考（通知書記載をそのまま転記）
  ADD COLUMN IF NOT EXISTS reason         TEXT;   -- 理由（通知書記載をそのまま転記）

COMMENT ON COLUMN bid_projects.bid_start_date IS '入札開始日（札入れ期間の開始）';
COMMENT ON COLUMN bid_projects.bid_date       IS '入札締切日（入札書提出締切。札入れ期間の終了。単日入札では入札日）';
COMMENT ON COLUMN bid_projects.remarks        IS '備考（指名通知書等の記載を転記）';
COMMENT ON COLUMN bid_projects.reason         IS '理由（指名通知書等の記載を転記）';
