-- ============================================================
-- 048: 工事写真ツリー ← 受検・試験リストの連携
-- 実行先: Supabase SQL Editor
-- 目的:
--   受検・試験リスト（project_inspection_tests）の各項目を、工事写真ツリー
--   （construction_photo_nodes）にも「撮影対象」として追加できるようにする。
--   写真ノードに由来の受検・試験ID（inspection_test_id）を持たせ、
--   ・重複追加を防ぐ（工事×試験IDで一意）
--   ・受検・試験を削除したら対応する写真ノードも自動削除（ON DELETE CASCADE）
--   撮影ツリー上は trade='検査・試験' でまとめて表示する（フロントは trade でグループ化）。
-- 冪等: 何度流しても安全（IF NOT EXISTS）。
-- ============================================================

ALTER TABLE construction_photo_nodes
  ADD COLUMN IF NOT EXISTS inspection_test_id BIGINT
    REFERENCES project_inspection_tests(id) ON DELETE CASCADE;

-- 工事内で同一の受検・試験から写真ノードを二重生成しない
CREATE UNIQUE INDEX IF NOT EXISTS uq_cphoto_nodes_insp_test
  ON construction_photo_nodes(project_id, inspection_test_id)
  WHERE inspection_test_id IS NOT NULL;
