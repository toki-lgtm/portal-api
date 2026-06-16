-- ============================================================
-- 026: 工事管理 - 数量内訳書（BOQ）の取込と工種別構成比率
-- 実行先: Supabase SQL Editor
-- 目的:
--   入札→工事へ昇格した工事に対し、数量書（内訳書 .xlsx）の明細を全行読み込み、
--   「工事内容・数量・金額」を構造化して保存する。さらに工種別に金額を集計して
--   構成比率を算出し、施工計画書チェックリストの絞り込み（不要書類のNA化）に使う。
--
--   - construction_boq            : 数量書の明細1行＝1レコード（工種/名称/数量/単位/単価/金額）
--   - construction_trade_summary  : 工種別の合計金額・構成比率（present=数量書に出現した工種）
--   - construction_projects に boq_total / boq_imported_at を追加
--
--   工種(trade) は required_doc_templates.trade の語彙へ正規化して保持する
--   （鉄筋 / 鉄骨 / コンクリート / 防水 / タイル / 石 / 木 / 屋根樋 / 金属 / 左官 /
--     塗装 / 内装 / 建具 / 解体 / 地業 / 土工事 / 仮設 / 安全 / 電気 / 機械 /
--     CB/ALC / ユニット / 共通 等）。これにより工種→施工計画書の突合が可能になる。
--
--   RLS は他テーブルと同様にオフ（アプリ側 requireAuth + requireConstructionAccess で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS construction_trade_summary CASCADE;
DROP TABLE IF EXISTS construction_boq           CASCADE;

-- ── 1) 工事案件に数量書サマリ列を追加（additive）──────────────
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS boq_total       BIGINT;       -- 数量書の総額（円・税抜）
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS boq_imported_at TIMESTAMPTZ;  -- 直近の数量書取込日時

-- ── 2) 数量書 明細（工事内容・数量・金額）────────────────────
CREATE TABLE construction_boq (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  source_file  TEXT,                              -- 取込元ファイル名
  sheet_name   TEXT,                              -- 由来シート名
  level        INT  NOT NULL DEFAULT 1,           -- 0=工種(科目)見出し / 1=明細
  trade        TEXT,                              -- 正規化した工種（templates.trade 語彙）
  raw_category TEXT,                              -- 数量書原文の工種/区分名（正規化前）
  item_name    TEXT,                              -- 名称・摘要
  spec         TEXT,                              -- 規格・仕様
  quantity     NUMERIC,                           -- 数量
  unit         TEXT,                              -- 単位
  unit_price   NUMERIC,                           -- 単価（円）
  amount       BIGINT,                            -- 金額（円・税抜）
  sort_order   INT  NOT NULL DEFAULT 0,           -- 表示順（読込順）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boq_project ON construction_boq(project_id);
CREATE INDEX IF NOT EXISTS idx_boq_trade   ON construction_boq(project_id, trade);

-- ── 3) 工種別 集計 ＋ 構成比率 ───────────────────────────────
CREATE TABLE construction_trade_summary (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  trade       TEXT   NOT NULL,                    -- 正規化工種
  amount      BIGINT NOT NULL DEFAULT 0,          -- 工種合計金額（円）
  ratio       NUMERIC,                            -- 構成比率（amount / boq_total, 0.0〜1.0）
  item_count  INT    NOT NULL DEFAULT 0,          -- 明細件数
  present      BOOLEAN NOT NULL DEFAULT TRUE,     -- 数量書に出現した工種か
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, trade)
);

CREATE INDEX IF NOT EXISTS idx_trade_sum_project ON construction_trade_summary(project_id);
