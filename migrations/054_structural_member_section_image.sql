-- ============================================================
-- 054: 工事管理 — 構造部材に「断面図」参照を追加（additive）
-- 実行先: Supabase SQL Editor
-- 目的:
--   構造リストの各符号の断面図（配筋断面）を切り出して保持する。
--   画像本体は construction-files バケット（署名URL配信）に置き、
--   ここには参照（バケットパス or "drive:<id>"）と抽出元ページを持つ。
--   切り出しは図面の罫線グリッド＋主筋密度から機械的に行う（AI bbox不使用）。
-- 関連: construction_structural_members(053)
-- ============================================================

ALTER TABLE construction_structural_members
  ADD COLUMN IF NOT EXISTS section_image_ref TEXT;   -- 断面図の参照（バケットパス or drive:<id>）

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('054_structural_member_section_image', now(), '構造部材に断面図参照 section_image_ref を追加')
ON CONFLICT (version) DO NOTHING;
