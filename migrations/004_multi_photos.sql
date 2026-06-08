-- ============================================================
-- 004: 指摘写真の複数枚対応 / 現場写真（点検単位・複数枚）
-- 実行先: Supabase SQL Editor
-- ============================================================

-- 1) 指摘写真を複数枚対応（配列カラムを追加）
--    既存の単数 issue_image_url は後方互換のため残すが、今後は配列を使用
ALTER TABLE inspection_details
  ADD COLUMN IF NOT EXISTS issue_image_urls TEXT[] DEFAULT '{}';

-- 既存の単数データがあれば配列へ移行（データ0でも無害）
UPDATE inspection_details
  SET issue_image_urls = ARRAY[issue_image_url]
  WHERE issue_image_url IS NOT NULL
    AND (issue_image_urls IS NULL OR issue_image_urls = '{}');

-- 2) 現場写真（点検単位・複数枚）
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS site_photo_urls TEXT[] DEFAULT '{}';
