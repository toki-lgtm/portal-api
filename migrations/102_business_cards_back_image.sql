-- ============================================================
-- 102: 名刺の裏面画像
-- 実行先: Supabase SQL Editor
-- 目的:
--   名刺を両面（表・裏）で保存できるようにする。
--   - business_cards.back_image_ref : 裏面画像の参照（'drive:<fileId>' 形式 / NULL=裏面なし）
--   既存の image_ref は「表面」として扱う（OCR は従来どおり表面で実行）。
--   両面スキャン（ScanSnap の2ページPDF・スマホで表裏2枚撮影など）に対応する。
-- 冪等（IF NOT EXISTS）。既存データは変更しない。
-- ============================================================

ALTER TABLE business_cards
  ADD COLUMN IF NOT EXISTS back_image_ref TEXT;   -- 裏面画像。'drive:<fileId>' 形式。裏面なしは NULL

COMMENT ON COLUMN business_cards.back_image_ref IS '裏面画像の参照（drive:<fileId>）。image_ref=表面。NULL=裏面なし';
