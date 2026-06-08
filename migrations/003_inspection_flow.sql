-- ============================================================
-- 003: 点検フロー高度化（項目ごと評価 / 指摘写真 / 改善期限）
-- 実行先: Supabase SQL Editor
-- 前提: inspections / projects / staff_master / inspection_master は作成済み
--       inspection_details は未作成だったため新規作成する
-- ============================================================

-- 1) 点検テーブルに作業所長を追加（要件: 作業所長を選択）
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES staff_master(id);

-- 2) 点検明細テーブルを新規作成（改善期限 due_date / updated_at を含む）
--    result は '良' / '指摘あり' を格納
CREATE TABLE IF NOT EXISTS inspection_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES inspection_master(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  result TEXT NOT NULL,
  issue_content TEXT,
  issue_image_url TEXT,
  due_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3) 指摘写真用の Storage バケット（公開読み取り）
INSERT INTO storage.buckets (id, name, public)
VALUES ('inspection-photos', 'inspection-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "inspection_photos_public_read" ON storage.objects;
CREATE POLICY "inspection_photos_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'inspection-photos');

-- 4) インデックス
CREATE INDEX IF NOT EXISTS idx_inspection_details_inspection_id
  ON inspection_details(inspection_id);
CREATE INDEX IF NOT EXISTS idx_inspection_details_due_date
  ON inspection_details(due_date);
CREATE INDEX IF NOT EXISTS idx_inspection_details_result
  ON inspection_details(result);
