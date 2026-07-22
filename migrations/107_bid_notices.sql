-- ============================================================
-- 107: 入札公告 日次収集
-- 実行先: Supabase SQL Editor
-- 目的:
--   九州防衛局・対馬市・長崎県(対馬振興局)の工事入札公告を日次収集し、
--   レビュー用にプールする。選んだものだけ既存 bid_projects へ昇格。
--   - bid_notices          : 収集した公告本体（重複排除の実体）
--   - bid_collection_runs  : 日次実行のログ（件数・エラーの監査）
--   RLS は他テーブルと同様オフ（アプリ側 requireAuth + requireBidAccess で制御）。
-- ============================================================

DROP TABLE IF EXISTS bid_collection_runs CASCADE;
DROP TABLE IF EXISTS bid_notices         CASCADE;

-- ── 1) 公告本体 ───────────────────────────────────────────────
CREATE TABLE bid_notices (
  id                BIGSERIAL PRIMARY KEY,

  -- 出所
  source            TEXT NOT NULL,        -- 'kyushu_defense' | 'tsushima_city' | 'nagasaki_pref'
  source_agency     TEXT,                 -- 発注機関名（九州防衛局 / 対馬市 / 長崎県対馬振興局 等）
  notice_url        TEXT,                 -- 公告詳細・PDFへのリンク（原本）
  external_key      TEXT NOT NULL,        -- 重複判定キー（source内で一意。工事番号 or URL 由来）

  -- 公告内容（抽出）
  project_name      TEXT NOT NULL,        -- 工事名
  work_type         TEXT,                 -- 工種
  bid_method        TEXT,                 -- 入札方式（一般競争 / 指名 / 制限付き一般競争 等）
  location          TEXT,                 -- 工事場所（原文）
  prefecture        TEXT,                 -- 県（福岡/佐賀/長崎/大分・絞り込み用に正規化）
  is_tsushima       BOOLEAN DEFAULT FALSE,-- 対馬島内か（対馬市/対馬振興局の対象判定）
  summary           TEXT,                 -- 工事概要

  -- 重要日付
  notice_date       DATE,                 -- 公告日
  question_due      DATE,                 -- 質問期限
  bid_date          DATE,                 -- 入札締切/入札日
  opening_date      DATE,                 -- 開札日

  -- 金額
  budget_price      BIGINT,               -- 予定価格（公表時のみ）

  -- レビュー状態
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN (
                      'new',        -- 新着（未確認）
                      'reviewed',   -- 確認済（様子見）
                      'promoted',   -- 案件として登録済
                      'dismissed'   -- 見送り
                    )),
  promoted_bid_project_id BIGINT REFERENCES bid_projects(id) ON DELETE SET NULL,

  -- 監査
  raw_text          TEXT,                 -- 抽出元テキスト（デバッグ・再抽出用）
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (source, external_key)
);

CREATE INDEX idx_bid_notices_status     ON bid_notices (status);
CREATE INDEX idx_bid_notices_source     ON bid_notices (source);
CREATE INDEX idx_bid_notices_notice_dt  ON bid_notices (notice_date DESC);
CREATE INDEX idx_bid_notices_collected  ON bid_notices (collected_at DESC);

-- ── 2) 実行ログ ───────────────────────────────────────────────
CREATE TABLE bid_collection_runs (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,            -- 上記 source（'all' = 全ソース一括起動の親記録）
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  found_count   INTEGER DEFAULT 0,        -- ページから拾えた公告数
  target_count  INTEGER DEFAULT 0,        -- 対象（対馬島内/北部九州）に合致した数
  new_count     INTEGER DEFAULT 0,        -- 今回新規に保存した数
  ok            BOOLEAN,                  -- 成否
  error         TEXT                      -- エラー概要（失敗時）
);

CREATE INDEX idx_bid_runs_started ON bid_collection_runs (started_at DESC);
