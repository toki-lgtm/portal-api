-- ============================================================
-- 016: 資格者証メタ情報（発行者・本籍地）を社員資格に追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   束ねPDF一括取込機能（POST /api/qualifications/scan）の強化に伴い、
--   証書に記載された発行者（建設大臣・県知事等）と本籍地を
--   staff_qualifications テーブルに保持できるようにする。
-- ============================================================

ALTER TABLE staff_qualifications
  ADD COLUMN IF NOT EXISTS issuer TEXT,   -- 証書の発行者（例: 建設大臣、長崎県知事、国土交通大臣）
  ADD COLUMN IF NOT EXISTS honseki TEXT;  -- 証書記載の本籍地（例: 福岡県）
