-- ============================================================
-- 069: ISO14001 環境 月次使用量
-- 実行先: Supabase SQL Editor
-- 目的:
--   2026年11月の14001初回審査に向けた運用実績づくり。電気・燃料・水道・
--   ガス・コピー用紙・産廃の月次使用量を拠点別に記録する。
--   出典（列構成の参考のみ・実データseedは無し）:
--     G:/共有ドライブ/中原建設 共有/② その他/002.ISO関係/☆14001(環境)☆/唯作成/
--     配下の 電気・水道／燃料／ガス／コピー用紙／産廃 各ファイル。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_env_usage_monthly CASCADE;
CREATE TABLE iso_env_usage_monthly (
  id           SERIAL PRIMARY KEY,
  fiscal_year  TEXT,                        -- 年度（例: '2026'）
  location     TEXT NOT NULL,               -- 本社 / 福岡支社
  category     TEXT NOT NULL,               -- 電気 / 燃料 / 水道 / ガス / 紙 / 産廃
  item         TEXT,                        -- 品目（例: ガソリン、都市ガス、コピー用紙 等）
  vendor       TEXT,                        -- 購入先・契約先
  ym           TEXT NOT NULL,               -- YYYY-MM
  quantity     NUMERIC,                     -- 使用量
  unit         TEXT,                        -- 単位（kL, t, 千kWh, m3, 枚 等）
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_env_usage_ym       ON iso_env_usage_monthly(ym);
CREATE INDEX idx_iso_env_usage_category ON iso_env_usage_monthly(category);
CREATE INDEX idx_iso_env_usage_location ON iso_env_usage_monthly(location);

-- seedデータなし（唯作成の実ファイルは列構成の参考のみ。運用開始後に入力）

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('069_iso_env_usage_monthly', now(), 'ISO14001 環境 月次使用量（拠点×カテゴリ×年月、seedなし）') ON CONFLICT (version) DO NOTHING;
