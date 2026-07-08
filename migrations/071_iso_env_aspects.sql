-- ============================================================
-- 071: ISO14001 環境 環境側面（著しい環境側面の判定）
-- 実行先: Supabase SQL Editor
-- 目的:
--   部門・工程ごとの環境側面／環境影響を登録し、方針・法規制・利害関係者・
--   危険性の4フラグのいずれかが立てば「著しい環境側面」と自動判定する
--   （6.1.2 相当）。判定式は単純ORで、フラグ追加時もアプリ側の変更不要。
--   seedデータなし（運用開始後に部門ヒアリングで登録）。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_env_aspects CASCADE;
CREATE TABLE iso_env_aspects (
  id                SERIAL PRIMARY KEY,
  category          TEXT NOT NULL DEFAULT '通常'
                      CHECK (category IN ('通常', '非通常', '緊急時')),
  dept              TEXT,                        -- 部門
  process           TEXT,                        -- 工程
  aspect            TEXT NOT NULL,               -- 環境側面
  impact            TEXT,                        -- 環境影響
  policy_flag       BOOLEAN NOT NULL DEFAULT false, -- 方針との関連
  legal_flag        BOOLEAN NOT NULL DEFAULT false, -- 法的要求事項との関連
  stakeholder_flag  BOOLEAN NOT NULL DEFAULT false, -- 利害関係者の関心
  hazard_flag       BOOLEAN NOT NULL DEFAULT false, -- 危険性・有害性
  significant       BOOLEAN GENERATED ALWAYS AS
                      (policy_flag OR legal_flag OR stakeholder_flag OR hazard_flag) STORED, -- 著しい環境側面
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_env_aspects_dept ON iso_env_aspects(dept);
CREATE INDEX idx_iso_env_aspects_sig  ON iso_env_aspects(significant);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('071_iso_env_aspects', now(), 'ISO14001 環境側面（4フラグORで著しい側面を自動判定、seedなし）') ON CONFLICT (version) DO NOTHING;
