-- ============================================================
-- 027: 工事管理 - 数量書（工事費内訳明細書）の階層保持リファクタ
-- 実行先: Supabase SQL Editor
--
-- 026 は数量書を「工種(科目)見出し / 明細」の2階層へ平坦化し、固定工種に寄せて
-- 「その他」でまとめていた。本 027 は 国交省/防衛省 標準様式の
--   種目 → 科目 → 細目 → 別紙
-- という4階層を、Excel の表記・順序のまま保持できるよう construction_boq を作り直す。
--
--   - kind        : 種目 / 科目 / 細目 / 別紙 / 共通費（種目に属さない積上明細など）
--   - level       : 0=種目(共通費) / 1=科目 / 2=細目 / 3=別紙
--   - path        : ゼロ詰めの階層パス（例 "001.002.003.001"）。pre-order の並び順キー
--   - seq         : 同階層内の兄弟順
--   - group_label : ブロック内の小見出し帯（<撤去> や (海栗島分屯基地) など）
--   - beppi_no    : 別紙番号（細目→別紙 の紐付け。例 "00-0001"）
--   - raw_category: その行が属する科目（工種）の原文名
--   - trade       : 科目名から正規化した工種（templates.trade 語彙。構成比率/NA 用）
--
--   construction_trade_summary は 026 のまま（科目名ベースで集計）。
--   RLS は他テーブル同様オフ（アプリ側 requireAuth + requireConstructionAccess で制御）。
-- ============================================================

-- ── 再実行を安全に。trade_summary は構成は同じだが FK 連動のため一緒に作り直す ──
DROP TABLE IF EXISTS construction_trade_summary CASCADE;
DROP TABLE IF EXISTS construction_boq           CASCADE;

-- ── 工事案件の数量書サマリ列（026 で追加済。未適用環境のため additive に再掲）──
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS boq_total       BIGINT;       -- 直接工事費 計（円・税抜）
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS boq_imported_at TIMESTAMPTZ;  -- 直近の数量書取込日時

-- ── 数量書 階層ノード（種目/科目/細目/別紙/共通費を1テーブルに pre-order で保持）──
CREATE TABLE construction_boq (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  source_file  TEXT,                              -- 取込元ファイル名
  sheet_name   TEXT,                              -- 由来シート名
  kind         TEXT NOT NULL DEFAULT '細目',      -- 種目/科目/細目/別紙/共通費
  level        INT  NOT NULL DEFAULT 2,           -- 0種目 1科目 2細目 3別紙
  path         TEXT,                              -- 階層パス（例 "001.002.003"）。並び順キー
  seq          INT  NOT NULL DEFAULT 0,           -- 兄弟順
  group_label  TEXT,                              -- 小見出し帯（<撤去>/(地区名) など）
  trade        TEXT,                              -- 正規化工種（templates.trade 語彙）
  raw_category TEXT,                              -- 所属科目（工種）の原文名
  item_name    TEXT,                              -- 名称
  spec         TEXT,                              -- 摘要・規格
  quantity     NUMERIC,                           -- 数量
  unit         TEXT,                              -- 単位
  unit_price   NUMERIC,                           -- 単価（円）
  amount       BIGINT,                            -- 金額（円・税抜）
  beppi_no     TEXT,                              -- 別紙番号（細目↔別紙 の紐付け）
  sort_order   INT  NOT NULL DEFAULT 0,           -- 読込順（pre-order）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boq_project ON construction_boq(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_boq_trade   ON construction_boq(project_id, trade);
CREATE INDEX IF NOT EXISTS idx_boq_kind    ON construction_boq(project_id, kind);

-- ── 工種（科目）別 集計 ＋ 構成比率（その他で括らず、科目名そのままを集計）──
CREATE TABLE construction_trade_summary (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  trade       TEXT   NOT NULL,                    -- 科目（工種）名 ＝ Excel 表記そのまま
  canonical   TEXT,                               -- 正規化工種（NA 候補算出用、無ければ NULL）
  amount      BIGINT NOT NULL DEFAULT 0,          -- 工種合計金額（円）
  ratio       NUMERIC,                            -- 構成比率（amount / 直接工事費計, 0.0〜1.0）
  item_count  INT    NOT NULL DEFAULT 0,          -- 科目ノード件数
  present     BOOLEAN NOT NULL DEFAULT TRUE,      -- 数量書に出現した工種か
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, trade)
);

CREATE INDEX IF NOT EXISTS idx_trade_sum_project ON construction_trade_summary(project_id);
