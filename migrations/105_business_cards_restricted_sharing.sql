-- 105_business_cards_restricted_sharing.sql
-- 目的: 名刺の「特定メンバー限定共有」を可能にする。
--   - visibility に 'restricted'（限定共有）を追加（既存は 'private' / 'shared'）
--   - shared_with TEXT[] : visibility='restricted' のとき、owner 以外に閲覧を許可するメール一覧
--   - 配列検索用の GIN インデックス
-- 前提: 033_business_cards.sql 適用済み。
-- 冪等: 何度流しても安全。

-- ── (1) visibility の CHECK 制約を張り替え（'restricted' を許可） ──
--   033 のインライン CHECK は自動命名。visibility を参照する CHECK を全て落としてから貼り直す。
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'business_cards'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%visibility%'
  LOOP
    EXECUTE format('ALTER TABLE business_cards DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE business_cards
  ADD CONSTRAINT business_cards_visibility_check
  CHECK (visibility IN ('private', 'shared', 'restricted'));

-- ── (2) 共有先カラム ──
ALTER TABLE business_cards
  ADD COLUMN IF NOT EXISTS shared_with TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN business_cards.shared_with IS
  'visibility=restricted のとき、owner_email 以外に閲覧を許可するメール一覧（小文字）。他の visibility では無視。';

-- ── (3) 配列包含検索用インデックス ──
CREATE INDEX IF NOT EXISTS idx_cards_shared_with ON business_cards USING GIN (shared_with);
