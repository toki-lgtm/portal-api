-- ============================================================
-- 034: 名刺カテゴリ管理
-- 実行先: Supabase SQL Editor
-- 目的:
--   名刺の分類管理と、ユーザー別のカテゴリ候補保存を実現する。
--   (1) business_cards に category 列を追加
--   (2) card_categories テーブルを新規作成（ユーザー別カテゴリ保存）
--
-- 前提: 033_business_cards.sql が適用済みであること。
-- RLS: 他テーブルと同様にオフ（アプリ側の requireAuth で制御）。
-- ============================================================

-- ── (1) business_cards に category 列を追加 ─────────────────
ALTER TABLE business_cards
  ADD COLUMN IF NOT EXISTS category TEXT;

-- ── (2) card_categories テーブル（ユーザー別カテゴリ保存）────
-- 再実行を安全にするための初期化
DROP TABLE IF EXISTS card_categories CASCADE;

CREATE TABLE card_categories (
  user_email  TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, name)
);

-- RLS オフ（アプリ側の requireAuth + requireCardAccess で制御）
ALTER TABLE card_categories DISABLE ROW LEVEL SECURITY;

-- インデックス（user_email で絞り込む検索が主）
CREATE INDEX IF NOT EXISTS idx_card_categories_user_email
  ON card_categories(user_email);
