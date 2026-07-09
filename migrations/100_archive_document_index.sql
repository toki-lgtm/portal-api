-- ============================================================
-- 100: 過去工事アーカイブ AI索引（archive_document_index）
-- 実行先: Supabase SQL Editor
-- 目的:
--   10.過去工事アーカイブ（Drive 正本・スキャンPDF）を Gemini で読み取り、
--   「書類種別・日付・要約・工事メタ（発注者/年度/工種）」を抽出して索引化し、
--   工事をまたいだ横断検索を可能にする。閲覧UIは従来どおり Drive 正本を参照。
--
--   方式: Drive を正本・DBは索引（メタデータ）のみ持つ。本文は保存しない。
--         drive_file_id を正本キーにして冪等（再索引は upsert）。
--   RLS はオフ（アプリ側 requireAuth / requireAdmin で制御）。
--   全文検索は pg_trgm（法令機能で導入済み）を要約・キーワードに使う。
--
--   1PDF に複数書類が混在するスキャンがあるため、doc_type は代表種別（複数は
--   「/」区切り）、date_text は原文の日付列挙（和暦可）、doc_date は代表日付。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS archive_document_index CASCADE;
CREATE TABLE archive_document_index (
  id               SERIAL PRIMARY KEY,
  scope            TEXT NOT NULL DEFAULT 'kouji',   -- kouji / jinji
  drive_file_id    TEXT UNIQUE,                     -- Drive 正本ファイルID（正本キー・冪等）
  kouji_folder_id  TEXT,                            -- 工事フォルダの Drive ID
  kouji_name       TEXT,                            -- 工事名（フォルダ名）
  file_name        TEXT NOT NULL,                   -- 元ファイル名
  file_size        BIGINT,                          -- バイト数
  doc_type         TEXT,                            -- 書類種別（複数は「/」区切り）
  doc_date         DATE,                            -- 代表日付（西暦）
  date_text        TEXT,                            -- 抽出した日付の原文（和暦・複数可）
  summary          TEXT,                            -- 要約
  client_name      TEXT,                            -- 発注者
  fiscal_year      TEXT,                            -- 年度（例: 令和6年度 / 2024年度）
  work_type        TEXT,                            -- 工種
  keywords         TEXT,                            -- 検索補助キーワード（空白区切り）
  page_count       INT,                             -- ページ数（取得できれば）
  raw_json         JSONB,                           -- Gemini 生出力
  model            TEXT,                            -- 使用モデル
  status           TEXT NOT NULL DEFAULT 'indexed', -- indexed / error / skipped
  error_message    TEXT,
  indexed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_archive_idx_kouji     ON archive_document_index(kouji_folder_id);
CREATE INDEX idx_archive_idx_doctype   ON archive_document_index(doc_type);
CREATE INDEX idx_archive_idx_client    ON archive_document_index(client_name);
CREATE INDEX idx_archive_idx_year      ON archive_document_index(fiscal_year);
CREATE INDEX idx_archive_idx_date      ON archive_document_index(doc_date);
CREATE INDEX idx_archive_idx_summary_trgm  ON archive_document_index USING gin (summary  gin_trgm_ops);
CREATE INDEX idx_archive_idx_keywords_trgm ON archive_document_index USING gin (keywords gin_trgm_ops);
