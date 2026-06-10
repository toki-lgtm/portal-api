-- ============================================================
-- 015: 入札案件管理
-- 実行先: Supabase SQL Editor
-- 目的:
--   入札案件の進捗・期限・金額・資料を一元管理する。
--   - bid_projects        : 案件本体（工事名 / 発注者 / ステータス / 日付 / 金額 / 担当 等）
--   - bid_documents       : 添付資料（設計書PDF・図面など。本体は Storage、ここはメタ）
--   - bid_status_history  : ステータス変更ログ（分析・監査用）
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth + requireBidAccess で制御）。
--
-- 併せて Supabase Storage に非公開バケット 'bid-documents' を作成すること
-- （ダッシュボード → Storage → New bucket → Public: OFF）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS bid_status_history CASCADE;
DROP TABLE IF EXISTS bid_documents      CASCADE;
DROP TABLE IF EXISTS bid_projects       CASCADE;

-- ── 1) 案件本体 ───────────────────────────────────────────────
CREATE TABLE bid_projects (
  id              BIGSERIAL PRIMARY KEY,

  -- 基本情報
  project_name    TEXT NOT NULL,                       -- 工事名
  client_name     TEXT,                                -- 発注者（県土木 / ○○市 等）
  location        TEXT,                                -- 工事場所
  work_type       TEXT,                                -- 工種（道路 / 橋梁 / 舗装 等・自由文字列）
  bid_method      TEXT,                                -- 入札方式（一般競争 / 指名 / 随契 等・自由文字列）

  -- ステータス
  status          TEXT NOT NULL DEFAULT 'collecting'
                  CHECK (status IN (
                    'collecting',   -- 情報収集
                    'judging',      -- 参加判断
                    'estimating',   -- 積算中
                    'bid',          -- 入札済
                    'won',          -- 落札
                    'lost',         -- 失注
                    'contracted',   -- 契約
                    'declined'      -- 不参加（見送り）
                  )),

  -- 重要日付
  notice_date     DATE,                                -- 公告日
  question_due    DATE,                                -- 質問期限
  bid_start_date  DATE,                                -- 入札開始日（札入れ期間の開始。単日入札では空）
  bid_date        DATE,                                -- 入札締切日（入札書提出締切＝札入れ期間の終了。単日入札では入札日）
  opening_date    DATE,                                -- 開札日

  -- 通知書からの転記（社内メモ note とは別枠）
  remarks         TEXT,                                -- 備考（指名通知書等の記載を転記）
  reason          TEXT,                                -- 理由（指名通知書等の記載を転記）

  -- 金額（円・整数。税区分は持たない）
  budget_price    BIGINT,                              -- 予定価格（公表されている場合）
  our_estimate    BIGINT,                              -- 自社見積（積算結果）
  awarded_price   BIGINT,                              -- 落札額
  awarded_company TEXT,                                -- 落札業者（他社落札時の記録にも使う）

  -- 担当・備考
  staff_id        TEXT REFERENCES staff_master(id),    -- 入札担当（staff_master 参照）
  note            TEXT,                                 -- メモ（自由記述）

  -- 管理
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,        -- 論理削除フラグ
  created_by      TEXT,                                 -- 作成者メール
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bids_status    ON bid_projects(status);
CREATE INDEX IF NOT EXISTS idx_bids_bid_date  ON bid_projects(bid_date);
CREATE INDEX IF NOT EXISTS idx_bids_staff     ON bid_projects(staff_id);
CREATE INDEX IF NOT EXISTS idx_bids_is_active ON bid_projects(is_active);

-- ── 2) 添付資料 ───────────────────────────────────────────────
-- ファイル本体は Supabase Storage（バケット: bid-documents）に保存し、メタのみ記録
CREATE TABLE bid_documents (
  id           BIGSERIAL PRIMARY KEY,
  bid_id       BIGINT NOT NULL REFERENCES bid_projects(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,                          -- 元のファイル名
  storage_path TEXT NOT NULL,                          -- Storage 内パス
  doc_type     TEXT,                                   -- 種別（設計書 / 図面 / 仕様書 / その他）
  size_bytes   BIGINT,
  uploaded_by  TEXT,                                   -- アップロード者メール
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bid_docs_bid ON bid_documents(bid_id);

-- ── 3) ステータス変更ログ ─────────────────────────────────────
CREATE TABLE bid_status_history (
  id          BIGSERIAL PRIMARY KEY,
  bid_id      BIGINT NOT NULL REFERENCES bid_projects(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  TEXT,                                    -- 変更者メール
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bid_hist_bid ON bid_status_history(bid_id);
