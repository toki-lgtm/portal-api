-- ============================================================
-- 036: 見積比較（quote_compare）— BOQ行レベル比較・6類型分類・ハイブリッド構成
-- 実行先: Supabase SQL Editor
--
-- 【経緯】本ファイルは当初「estimate-comparison（工種別のGemini Vision比較）」の
--   スタブだったが、設計書（D:\01.claude code\04.アプリ\見積比較_設計書.md＝正）に基づき
--   quote_compare（築城で確立した相見積→単価書戻し→横並び比較→最安見積の機能化）へ
--   全面的に置換(supersede)した。旧 estimate_* テーブルは未使用・無データのため DROP する。
--
-- 目的:
--   1つの入札時積算数量書（工事×分野）を骨格(BOQ行)に分解し、複数社の見積単価を
--   「公式数量」に当てて同一土俵で横並び比較し、行ごと最安・最安見積を生成する。
--   各見積はまず6類型（書式軸 official/vendor × 媒体軸 excel/text_pdf/image_pdf）へ
--   自動分類してから抽出・照合をルーティングする。
--
--   テーブル構成:
--     quote_compare_projects : 比較プロジェクト（＝1つの数量書。入札案件に任意紐付け）
--     quote_boq_rows         : 比較の骨格（原本テンプレの行。書き戻し用に sheet/excel_row を保持）
--     quote_vendors          : 比較対象の各社（6類型分類・NET按分・除外メモを保持）
--     quote_cells            : 各社 × BOQ行 の単価（比較行列の本体）
--     quote_unmatched        : 照合できなかった抽出行（要レビュー）
--
--   RLS はオフ（アプリ側 requireAuth + requireQuoteCompareAccess で制御）。
-- ============================================================

-- ── 旧 estimate-comparison スタブの撤去（未使用・無データ。supersede）────────
DROP TABLE IF EXISTS estimate_trade_comments CASCADE;
DROP TABLE IF EXISTS estimate_vendor_trades  CASCADE;
DROP TABLE IF EXISTS estimate_vendors        CASCADE;
DROP TABLE IF EXISTS estimate_boq_nodes      CASCADE;
DROP TABLE IF EXISTS estimate_boq_trades     CASCADE;
DROP TABLE IF EXISTS estimate_projects       CASCADE;

-- ── 再実行を安全にするための初期化（依存関係の逆順で DROP）────────
DROP TABLE IF EXISTS quote_unmatched         CASCADE;
DROP TABLE IF EXISTS quote_cells             CASCADE;
DROP TABLE IF EXISTS quote_vendors           CASCADE;
DROP TABLE IF EXISTS quote_boq_rows          CASCADE;
DROP TABLE IF EXISTS quote_compare_projects  CASCADE;

-- ── 1) 比較プロジェクト（＝1つの数量書）───────────────────────────
CREATE TABLE quote_compare_projects (
  id                 BIGSERIAL    PRIMARY KEY,
  bid_project_id     BIGINT       REFERENCES bid_projects(id) ON DELETE SET NULL, -- 入札案件への任意紐付け
  name               TEXT         NOT NULL,    -- 例「築城(8)宿舎改修 その1 建築」
  client             TEXT,                     -- 発注者（例：九州防衛局）
  discipline         TEXT,                     -- 建築 / 機械 / 電気・通信
  template_drive_id  TEXT,                     -- 原本＝入札時積算数量書xlsxのDrive参照（drive:<id>）
  template_filename  TEXT,                     -- 原本ファイル名（書き戻しパッケージ用）
  boq_total          BIGINT,                   -- 直接工事費（取込時に算出・検算用）
  boq_imported_at    TIMESTAMPTZ,
  created_by         TEXT,                     -- 作成者メール
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE quote_compare_projects DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_qc_projects_created_by ON quote_compare_projects(created_by);
CREATE INDEX IF NOT EXISTS idx_qc_projects_bid        ON quote_compare_projects(bid_project_id);

-- ── 2) 比較の骨格（原本テンプレの行）──────────────────────────────
--   boqParser の nodes を保存。書き戻しのため Excel の (シート名, 物理行番号) を必ず保持する
--   （lib_quote は F{r}/G{r} に行番号で書くため）。
CREATE TABLE quote_boq_rows (
  id                   BIGSERIAL  PRIMARY KEY,
  project_id           BIGINT     NOT NULL REFERENCES quote_compare_projects(id) ON DELETE CASCADE,
  sheet_name           TEXT,                 -- 例「細目別内訳」「別紙明細 (2)」
  excel_row            INT,                  -- 原本の物理行番号（書き戻しの鍵・1始まり）
  path                 TEXT,                 -- 4階層パス（種目→科目→細目→別紙）
  level                INT        NOT NULL DEFAULT 2,   -- 0種目 1科目 2細目 3別紙
  kind                 TEXT,                 -- '種目'/'科目'/'細目'/'別紙'/'共通費'
  item_name            TEXT,
  spec                 TEXT,
  quantity_raw         TEXT,                 -- テキスト型のまま保持（"1,558   " / "▲1"）
  quantity_num         NUMERIC,              -- 数値化（照合・表示用、絶対値判定に使用）
  unit                 TEXT,                 -- 正規化済（か所/㎡/m3…）
  official_unit_price  NUMERIC,              -- 原本は空。将来の官積算単価用
  beppi_no             TEXT,                 -- 別紙番号（00-0001）。別紙横断比較に使用
  trade                TEXT,                 -- 正規化工種（候補絞り込み・構成比率）
  canonical            TEXT,                 -- 正規化工種（normalizeTrade 出力）
  sort_order           INT        NOT NULL DEFAULT 0    -- pre-order
);

ALTER TABLE quote_boq_rows DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_qc_boq_rows_project ON quote_boq_rows(project_id);
CREATE INDEX IF NOT EXISTS idx_qc_boq_rows_beppi   ON quote_boq_rows(project_id, beppi_no);

-- ── 3) 比較対象の各社 ─────────────────────────────────────────────
CREATE TABLE quote_vendors (
  id                  BIGSERIAL    PRIMARY KEY,
  project_id          BIGINT       NOT NULL REFERENCES quote_compare_projects(id) ON DELETE CASCADE,
  name                TEXT         NOT NULL,   -- 業者名
  form_type           TEXT,                    -- 書式軸 'official'(発注者書式)/'vendor'(各社書式)
  medium              TEXT,                    -- 媒体軸 'excel'/'text_pdf'/'image_pdf'
  class_no            INT,                     -- 1〜6（form_type×medium から導出）
  auto_classified     BOOLEAN      NOT NULL DEFAULT true,  -- 人が上書きしたら false
  classify_confidence TEXT,                    -- 'high'/'low'（low は確認必須）
  source_drive_ids    JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- 見積ファイルのDrive参照（複数可）
  list_total          BIGINT,                  -- 定価合計（NET按分の母数）
  net_total           BIGINT,                  -- 提示NET合計
  net_ratio           NUMERIC,                 -- net_total / list_total（既NET社は1.0）
  excluded            JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- ★釈統メモ＝除外項目[{label,amount,reason}]
  extracted_total     BIGINT,                  -- Σ(単価×公式数量)（検算用）
  status              TEXT         NOT NULL DEFAULT 'new',  -- new/classified/extracted/reviewed/confirmed
  created_by          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE quote_vendors DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_qc_vendors_project ON quote_vendors(project_id);

-- ── 4) 各社 × BOQ行 の単価（比較行列の本体）──────────────────────
CREATE TABLE quote_cells (
  id               BIGSERIAL  PRIMARY KEY,
  project_id       BIGINT     NOT NULL REFERENCES quote_compare_projects(id) ON DELETE CASCADE,
  vendor_id        BIGINT     NOT NULL REFERENCES quote_vendors(id) ON DELETE CASCADE,
  boq_row_id       BIGINT     NOT NULL REFERENCES quote_boq_rows(id) ON DELETE CASCADE,
  unit_price       NUMERIC,              -- NET単価（比較・最安に使う値）
  list_unit_price  NUMERIC,              -- 定価単価（NET按分前。監査用）
  amount           NUMERIC,              -- ＝公式数量×NET単価（表示用）
  match_type       TEXT,                 -- 'qty'(数量+単位完全一致)/'name'(名称類似)/'manual'
  sim              NUMERIC,              -- 名称類似スコア
  source_label     TEXT,                 -- その社の元 名称＋仕様（来歴）
  confidence       TEXT,                 -- 'high'/'review'（要人手確認）
  UNIQUE (vendor_id, boq_row_id)
);

ALTER TABLE quote_cells DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_qc_cells_project ON quote_cells(project_id);
CREATE INDEX IF NOT EXISTS idx_qc_cells_vendor  ON quote_cells(vendor_id);
CREATE INDEX IF NOT EXISTS idx_qc_cells_boq_row ON quote_cells(boq_row_id);

-- ── 5) 照合できなかった抽出行（要レビュー）────────────────────────
CREATE TABLE quote_unmatched (
  id              BIGSERIAL  PRIMARY KEY,
  project_id      BIGINT     NOT NULL REFERENCES quote_compare_projects(id) ON DELETE CASCADE,
  vendor_id       BIGINT     NOT NULL REFERENCES quote_vendors(id) ON DELETE CASCADE,
  name            TEXT,
  spec            TEXT,
  quantity        NUMERIC,
  unit            TEXT,
  unit_price      NUMERIC,
  best_candidate  JSONB,                -- 最良候補BOQ行の手がかり {boq_row_id,name,sim} 等
  sim             NUMERIC
);

ALTER TABLE quote_unmatched DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_qc_unmatched_project ON quote_unmatched(project_id);
CREATE INDEX IF NOT EXISTS idx_qc_unmatched_vendor  ON quote_unmatched(vendor_id);
