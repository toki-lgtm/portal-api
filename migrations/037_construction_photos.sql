-- ============================================================
-- 034: 工事管理 - 写真管理（サブポータル / 工事写真）
-- 実行先: Supabase SQL Editor
-- 目的:
--   現場で撮った工事写真を「撮るべき写真ツリー」に沿って整理・管理する。
--   ツリーは 数量書(construction_trade_summary の present 工種) × 撮影対象表マスタ
--   （国交省/文教施設 営繕「工事写真撮影要領」R5）から自動生成する。
--
--   - photo_spec_master       : 撮影対象表の辞書（建築/改修/電気/機械編）。工事横断の不変マスタ
--   - construction_photo_nodes: 工事ごとの写真ツリー（マスタ＋BOQから生成。手動追加/除外可）
--   - construction_photos     : 実写真（本体は共有ドライブ。ここは file_ref とメタのみ）
--
--   工種(trade) は construction_trade_summary / boqParser CANONICAL_TRADES の語彙に揃える
--   （共通 / 仮設 / 土工事 / 地業 / 鉄筋 / コンクリート / 鉄骨 / CB/ALC / 防水 / 石 /
--     タイル / 木 / 屋根樋 / 金属 / 左官 / 建具 / 塗装 / 内装 / ユニット / 解体 /
--     電気 / 機械 / 安全）。これにより BOQ present 工種 → 撮影ツリーの突合が可能。
--
--   電子納品基準（画素チェック/全角64字命名/写真帳出力）は今回スコープ外（将来フェーズ）。
--   RLS は他テーブルと同様にオフ（アプリ側 requireAuth + requireConstructionAccess で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS construction_photos      CASCADE;
DROP TABLE IF EXISTS construction_photo_nodes CASCADE;
DROP TABLE IF EXISTS photo_spec_master        CASCADE;

-- ── 1) 撮影対象表マスタ（辞書）────────────────────────────────
--   営繕「工事写真撮影要領」別添 撮影対象表を機械可読化したもの。
--   edition で版（建築/改修/電気/機械）を、trade で正規化工種を持つ。
--   seed は 035_photo_spec_master_seed.sql で投入する。
CREATE TABLE photo_spec_master (
  id           BIGSERIAL PRIMARY KEY,
  edition      TEXT NOT NULL,                  -- 版: '建築' / '改修' / '電気' / '機械'
  trade        TEXT NOT NULL,                  -- 正規化工種（CANONICAL_TRADES。'共通'=常時対象）
  category     TEXT NOT NULL,                  -- 工事種目又は分類（表示名。例: コンクリート工事）
  photo_item   TEXT,                           -- 撮影項目（例: 打込み締固め）
  target       TEXT NOT NULL,                  -- 撮影対象（例: 打込み・締固め状況）
  timing       TEXT,                           -- 撮影時期（例: 施工中 / 着手前 / 検査中）
  sort_order   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_photo_spec_edition ON photo_spec_master(edition);
CREATE INDEX IF NOT EXISTS idx_photo_spec_trade   ON photo_spec_master(trade);

-- ── 2) 工事ごとの写真ツリー（撮るべき写真の一覧）──────────────
--   数量書取込 or 工種大別から生成。source='auto'（マスタ由来）/'manual'（手動追加）。
--   is_active=false は「この工事では対象外」として除外（ツリーから隠す）。
CREATE TABLE construction_photo_nodes (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  master_id    BIGINT REFERENCES photo_spec_master(id) ON DELETE SET NULL,  -- 由来マスタ（手動はNULL）
  edition      TEXT,
  trade        TEXT,                           -- 工種（グルーピング/絞り込み用）
  category     TEXT NOT NULL,                  -- 工種種目又は分類
  photo_item   TEXT,                           -- 撮影項目
  target       TEXT NOT NULL,                  -- 撮影対象（＝この写真で撮るべきもの）
  timing       TEXT,                           -- 撮影時期
  source       TEXT NOT NULL DEFAULT 'auto'    -- 'auto' | 'manual'
                 CHECK (source IN ('auto','manual')),
  required     BOOLEAN NOT NULL DEFAULT TRUE,  -- 必須（撮影漏れ警告の対象）
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,  -- false=この工事では対象外
  sort_order   INT NOT NULL DEFAULT 0,
  note         TEXT,                           -- 現場メモ（任意）
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cphoto_nodes_project ON construction_photo_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_cphoto_nodes_trade   ON construction_photo_nodes(project_id, trade);
-- 同一工事に同一マスタ由来ノードを重複生成しない（再生成を冪等にする）
CREATE UNIQUE INDEX IF NOT EXISTS uq_cphoto_nodes_master
  ON construction_photo_nodes(project_id, master_id) WHERE master_id IS NOT NULL;

-- ── 3) 実写真（本体は共有ドライブ。ここは参照とメタ）──────────
--   node_id にぶら下げる。node を消しても写真は残せるよう ON DELETE SET NULL。
CREATE TABLE construction_photos (
  id           BIGSERIAL PRIMARY KEY,
  node_id      BIGINT REFERENCES construction_photo_nodes(id) ON DELETE SET NULL,
  project_id   BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  file_ref     TEXT NOT NULL,                  -- "drive:<fileId>" または Supabaseストレージのパス
  file_name    TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  taken_at     DATE,                           -- 撮影日（小黒板/手入力）
  location     TEXT,                           -- 撮影箇所（通り芯・階・部屋名 等）
  caption      TEXT,                           -- コメント
  blackboard   JSONB,                          -- 小黒板情報（任意。工種目/部位/寸法/立会者 等）
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cphotos_node    ON construction_photos(node_id);
CREATE INDEX IF NOT EXISTS idx_cphotos_project ON construction_photos(project_id);
