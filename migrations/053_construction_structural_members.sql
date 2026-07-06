-- ============================================================
-- 053: 工事管理 — 構造部材マスタ（柱・梁・基礎・杭・壁・鉄骨 等）
-- 実行先: Supabase SQL Editor
-- 目的:
--   構造図の「部材リスト（断面リスト）」を機械可読化して工事ごとに保持する。
--   実施設計図(100%)の 柱リスト/梁リスト/地中梁・基礎リスト/杭リスト/壁リスト/
--   鉄骨部材リスト を、ページ画像化 → Gemini で符号ごとに構造化抽出したもの。
--
--   使い道:
--     1) 工事マスタの一部（構造体の諸元）として蓄積・参照。
--     2) 工事写真の「配筋検査・型枠検査」を “符号×階” 単位で撮影漏れ管理する土台
--        （construction_photo_nodes に部材を展開＝段階2）。
--     3) 電子小黒板へ部材の断面・配筋を自動差込（段階3）。
--
--   抽出は必ず人のレビューを挟む（source='ai', confirmed=false で登録 →
--   画面で確認・是正 → confirmed=true）。既存の受検試験リスト等と同方式。
--
--   同一符号でも階ごとに配筋が変わる（例 C1: 4F=D13/3F=K13/2F=K16）ため、
--   一意キーは設けず (符号, 階) を並存させる。再取込は source='ai' かつ
--   未確定の行のみ入れ替える（確定済み・手動行は保持）。
--
--   RLS はオフ（他の工事管理テーブルと同様。アプリ側 requireAuth +
--   requireConstructionAccess で制御）。
-- 関連: construction_projects(023) / construction_photo_nodes(037) / construction_boq(027)
-- ============================================================

DROP TABLE IF EXISTS construction_structural_members CASCADE;

CREATE TABLE construction_structural_members (
  id                BIGSERIAL PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,

  member_type       TEXT NOT NULL,     -- 種別: 柱/大梁/小梁/地中梁/基礎/杭/壁/スラブ/鉄骨柱/鉄骨梁/デッキ/ブレース/その他
  symbol            TEXT NOT NULL,     -- 符号（例 C1, G1, FG1, SC1, W15。図の表記どおり）
  floor             TEXT,              -- 階・層・位置（例 4階 / R階 / 全断面 / 外端。任意）
  section           TEXT,              -- 断面（RC:900x1000 / 鉄骨:H-400x200x8x13 / 壁:t=180 / 杭:500φ）
  main_rebar        TEXT,              -- 主筋・上端下端筋・壁縦筋（例 16-D25 / 上端 5-D25 下端 4-D25）
  shear_rebar       TEXT,              -- 帯筋・あばら筋・壁横筋（例 D13@100 / K13@100=高強度）
  concrete_strength TEXT,              -- コンクリート強度 Fc（あれば。例 Fc24）
  note              TEXT,              -- 備考（位置・本数・支持力・ベースプレート寸法 等）

  source            TEXT NOT NULL DEFAULT 'manual'   -- 'ai'（図面抽出）| 'manual'（手入力）
                      CHECK (source IN ('ai','manual')),
  source_page       INT,               -- 抽出元の図面ページ（1始まり。任意）
  confirmed         BOOLEAN NOT NULL DEFAULT FALSE,   -- 人が内容を確認・確定したか
  raw_json          JSONB,             -- AI抽出の生レコード（再確認・監査用）

  sort_order        INT NOT NULL DEFAULT 0,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE construction_structural_members DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_struct_members_project ON construction_structural_members(project_id);
CREATE INDEX IF NOT EXISTS idx_struct_members_type    ON construction_structural_members(project_id, member_type);
CREATE INDEX IF NOT EXISTS idx_struct_members_symbol  ON construction_structural_members(project_id, symbol);

-- 台帳へ記録（051 schema_migrations_ledger 方式。version=拡張子なしフルファイル名）
INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('053_construction_structural_members', now(), '構造部材マスタ（柱/梁/基礎/杭/壁/鉄骨 等・図面リスト抽出）')
ON CONFLICT (version) DO NOTHING;
