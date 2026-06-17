-- ============================================================
-- 033: 名刺管理
-- 実行先: Supabase SQL Editor
-- 目的:
--   受け取った名刺を OCR で登録し、全社員が検索・閲覧できる名刺帳を実現する。
--   - business_cards : 名刺本体（氏名 / 会社 / 連絡先 / 画像参照 / 公開範囲 等）
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth + requireCardAccess で制御）。
--
-- 関連: 権限は staff_app_permissions の app_key='cards'（member/admin）。
--       server.js の allApps に key='cards' を登録すること。
-- Supabase Storage に非公開バケット 'card-images' を作成すること
-- （ダッシュボード → Storage → New bucket → Public: OFF）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS business_cards CASCADE;

-- ── 名刺本体 ─────────────────────────────────────────────────
CREATE TABLE business_cards (
  id             BIGSERIAL PRIMARY KEY,

  -- 名刺記載情報
  full_name      TEXT,                                    -- 氏名
  company        TEXT,                                    -- 会社名
  department     TEXT,                                    -- 部署
  title          TEXT,                                    -- 役職
  phone          TEXT,                                    -- 電話番号
  mobile         TEXT,                                    -- 携帯番号
  email          TEXT,                                    -- メールアドレス
  fax            TEXT,                                    -- FAX番号
  postal_code    TEXT,                                    -- 郵便番号
  address        TEXT,                                    -- 住所
  website        TEXT,                                    -- ウェブサイト
  qualifications TEXT,                                    -- 資格・自由記述（複数は改行/カンマ区切り）
  note           TEXT,                                    -- メモ（自由記述）

  -- ファイル参照
  image_ref      TEXT,                                    -- 'drive:<fileId>' 形式。画像なしは NULL

  -- 公開範囲・管理
  visibility     TEXT NOT NULL DEFAULT 'private'
                 CHECK (visibility IN ('private', 'shared')),
  owner_email    TEXT NOT NULL,                           -- 登録者メール（小文字）
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,           -- 論理削除フラグ

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── インデックス ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cards_owner_email ON business_cards(owner_email);
CREATE INDEX IF NOT EXISTS idx_cards_visibility  ON business_cards(visibility);
CREATE INDEX IF NOT EXISTS idx_cards_is_active   ON business_cards(is_active);
CREATE INDEX IF NOT EXISTS idx_cards_company     ON business_cards(company);
CREATE INDEX IF NOT EXISTS idx_cards_full_name   ON business_cards(full_name);
