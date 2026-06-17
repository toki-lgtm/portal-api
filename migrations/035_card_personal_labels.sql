-- ============================================================
-- 035: 名刺マイカテゴリ（個人ラベル）
-- 実行先: Supabase SQL Editor
-- 目的:
--   名刺に「本人だけに見える」個人ラベルを付けられるようにする。
--   既存の business_cards.category（全社カテゴリ）はそのまま温存し、
--   それとは別レイヤーとして個人ごとの分類を持たせる。
--   - card_personal_labels : (user_email, card_id) ごとに 1 つのラベル
--
-- 重要: このラベルはアプリ側で「本人のメールでのみ取得」する。
--       共有名刺に付けても他人には一切返さない（= 自分だけ見える）。
--       他人が登録した共有名刺にも、閲覧できる人なら自分用ラベルを付けられる。
--
-- 前提: 033_business_cards.sql / 034_card_categories.sql が適用済みであること。
-- RLS: 他テーブルと同様にオフ（アプリ側の requireAuth + requireCardAccess で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS card_personal_labels CASCADE;

CREATE TABLE card_personal_labels (
  user_email  TEXT        NOT NULL,                        -- 所有者（小文字メール）
  card_id     BIGINT      NOT NULL
              REFERENCES business_cards(id) ON DELETE CASCADE,
  label       TEXT        NOT NULL,                        -- 個人ラベル名
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, card_id)                        -- 本人×名刺で 1 ラベル
);

-- RLS オフ（アプリ側で制御）
ALTER TABLE card_personal_labels DISABLE ROW LEVEL SECURITY;

-- ── インデックス ──────────────────────────────────────────────
-- 一覧取得時に「自分のラベルだけ」をまとめて引く（user_email で絞る）
CREATE INDEX IF NOT EXISTS idx_card_personal_labels_user
  ON card_personal_labels(user_email);
-- 名刺削除連動・単一名刺引き当て用
CREATE INDEX IF NOT EXISTS idx_card_personal_labels_card
  ON card_personal_labels(card_id);
