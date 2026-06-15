-- ============================================================
-- 020: 文書回覧機能
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内ポータルに「文書回覧」機能を追加する。
--   まとめてスキャンした回覧書類PDF/画像を Gemini で自動分割し、
--   各書類を電子的に回覧する。既読・フラグ（要対応/重要）・
--   対応状況を管理し、管理者は到達率を確認できる。
--   - circular_documents: 回覧書類本体
--   - circular_targets:   宛先指定（会社・部署・個人）
--   - circular_responses: ユーザーごとの既読・対応状況
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth / 権限解決で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS circular_responses CASCADE;
DROP TABLE IF EXISTS circular_targets   CASCADE;
DROP TABLE IF EXISTS circular_documents CASCADE;

-- ── 1) 回覧書類本体 ─────────────────────────────────────────────
CREATE TABLE circular_documents (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      TEXT,                                        -- 同一アップロードバッチを束ねる識別子（UUID）
  title         TEXT NOT NULL,                              -- 書類タイトル
  doc_type      TEXT,                                       -- 書類種別（通達/案内/依頼/報告/その他）
  sender        TEXT,                                       -- 発信元
  original_ref  TEXT,                                       -- ファイル参照（drive:<fileId> または Supabase パス）
  mime          TEXT,                                       -- MIMEタイプ（application/pdf / image/* 等）
  size          BIGINT,                                     -- ファイルサイズ（バイト）
  page_from     INT,                                        -- 元の束ねPDF内の開始ページ（1始まり）
  page_to       INT,                                        -- 元の束ねPDF内の終了ページ（1始まり）
  ocr_text      TEXT,                                       -- Gemini が抽出した OCR テキスト（検索用）
  summary       TEXT,                                       -- 要約・補足メモ（管理者が手入力）
  meta          JSONB NOT NULL DEFAULT '{}',                -- 拡張フィールド（将来用）
  target_type   TEXT NOT NULL DEFAULT 'all'
                CHECK (target_type IN ('all', 'company', 'department', 'user')),
                                                            -- 宛先種別（'user' は circular_targets.kind='user' の併用）
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),  -- 'archived' = 論理削除相当
  created_by    TEXT,                                       -- 作成者メールアドレス
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2) 宛先詳細（会社・部署・個人指定の場合） ──────────────────
CREATE TABLE circular_targets (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL
                REFERENCES circular_documents(id) ON DELETE CASCADE,
  kind          TEXT
                CHECK (kind IN ('company', 'department', 'user')),
                                                            -- 'user': value = メールアドレス
  value         TEXT                                        -- 会社名 / 部署名 / メールアドレス
);

CREATE INDEX idx_circular_targets_document_id ON circular_targets(document_id);

-- ── 3) ユーザーごとの既読・対応状況 ───────────────────────────
CREATE TABLE circular_responses (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL
                  REFERENCES circular_documents(id) ON DELETE CASCADE,
  user_email      TEXT NOT NULL,                            -- 既読・対応ユーザーのメールアドレス
  read_at         TIMESTAMPTZ,                              -- 既読日時（NULL = 未読）
  action_label    TEXT
                  CHECK (action_label IS NULL OR action_label IN ('要対応', '重要')),
                                                            -- フラグ種別
  action_status   TEXT
                  CHECK (action_status IS NULL OR action_status IN ('未対応', '対応済')),
                                                            -- 対応状況（action_label='要対応' 時に使用）
  note            TEXT,                                     -- 本人メモ
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, user_email)
);

CREATE INDEX idx_circular_responses_document_id ON circular_responses(document_id);
CREATE INDEX idx_circular_responses_user_email  ON circular_responses(user_email);
