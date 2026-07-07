-- ============================================================
-- 055: 工事写真ツリー ← 構造部材マスタ（配筋・型枠検査の符号別 撮り漏れ管理）
-- 実行先: Supabase SQL Editor
-- 目的:
--   構造部材マスタ（construction_structural_members / 053）の RC 躯体部材を、
--   工事写真ツリー（construction_photo_nodes / 037）へ “符号×階” 単位で展開し、
--   各部材の「配筋検査」「型枠検査」を撮影対象として自動生成する（段階2）。
--   これにより 符号×階 ごとの撮影漏れ（配筋・型枠）をチェックできる。
--
--   写真ノードに由来の構造部材ID（structural_member_id）と検査種別
--   （member_check_kind = '配筋' | '型枠'）を持たせ、
--   ・同一部材×同一検査種別の二重生成を防ぐ（工事×部材×種別で一意）
--   ・構造部材を削除したら対応する写真ノードも自動削除（ON DELETE CASCADE）
--   撮影ツリー上は trade='躯体検査（符号別）' でまとめ、category=種別でグループ化する。
-- 冪等: 何度流しても安全（IF NOT EXISTS）。additive のみ（既存データ非破壊）。
-- 関連: construction_photo_nodes(037) / construction_structural_members(053)
-- ============================================================

ALTER TABLE construction_photo_nodes
  ADD COLUMN IF NOT EXISTS structural_member_id BIGINT
    REFERENCES construction_structural_members(id) ON DELETE CASCADE;

ALTER TABLE construction_photo_nodes
  ADD COLUMN IF NOT EXISTS member_check_kind TEXT;   -- '配筋' | '型枠'（構造部材由来のノードのみ）

-- 工事内で同一の構造部材×検査種別から写真ノードを二重生成しない
CREATE UNIQUE INDEX IF NOT EXISTS uq_cphoto_nodes_struct_member
  ON construction_photo_nodes(project_id, structural_member_id, member_check_kind)
  WHERE structural_member_id IS NOT NULL;

-- 台帳へ記録（051 schema_migrations_ledger 方式。version=拡張子なしフルファイル名）
INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('055_photo_nodes_from_structural_members', now(),
        '工事写真ツリーに構造部材由来の列（structural_member_id / member_check_kind）を追加＝配筋・型枠検査の符号別展開')
ON CONFLICT (version) DO NOTHING;
