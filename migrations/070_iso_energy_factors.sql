-- ============================================================
-- 070: ISO14001 環境 エネルギー換算係数（環境省算定・報告・公表制度 標準値）
-- 実行先: Supabase SQL Editor
-- 目的:
--   月次使用量(069)からCO2排出量を推計するための単位発熱量・排出係数マスタ。
--   出典: 【参考資料】単位発熱量／【参考資料】CO2排出係数 シート
--     G:/共有ドライブ/中原建設 共有/② その他/002.ISO関係/☆14001(環境)☆/9.1.1エネルギー換算表.xlsx
--     （原シートの出典表記: 気候変動対策指針〔大阪府 令和6年5月改正〕。値は
--      算定・報告・公表制度〔環境省〕の全国統一標準値と同一）。
--   電気（電気事業者等）はCO2排出係数が原本で「－」（未設定・電力会社ごとの
--   実排出係数を別途使用する運用のため）。よってco2_factorはNULLで登録。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御。GETのみなら誰でも可）。
-- ============================================================

DROP TABLE IF EXISTS iso_energy_factors CASCADE;
CREATE TABLE iso_energy_factors (
  id           SERIAL PRIMARY KEY,
  fiscal_year  TEXT,                        -- 年度（例: '2026'）。標準値のため年度共通で可
  fuel_type    TEXT NOT NULL,               -- 燃料・エネルギーの種類
  unit         TEXT NOT NULL,               -- 使用量の単位（kL, t, 千m3, 千kWh 等）
  heat_value   NUMERIC NOT NULL,            -- 単位発熱量（GJ／単位）
  co2_factor   NUMERIC,                     -- CO2排出係数（tCO2/GJ）。電気はNULL
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fiscal_year, fuel_type)
);

-- ── seed: 主要燃料種（原本の値をそのまま登録） ──
INSERT INTO iso_energy_factors (fiscal_year, fuel_type, unit, heat_value, co2_factor, note) VALUES
  ('2026', 'ガソリン', 'kL',   33.4, 0.0686, '原本表記: ガソリン（Ｅ３ガソリン、バイオガソリンを除く）'),
  ('2026', '灯油',     'kL',   36.5, 0.0686, NULL),
  ('2026', '軽油',     'kL',   38,   0.0689, NULL),
  ('2026', 'A重油',    'kL',   38.9, 0.0708, NULL),
  ('2026', 'LPG',      't',    50.1, 0.0598, '原本表記: 石油ガス（液化石油ガス(LPG)）'),
  ('2026', '都市ガス', '千m3', 40,   0.0513, NULL),
  ('2026', '電気',     '千kWh', 8.64, NULL,  '原本表記: 電気事業者等。CO2排出係数は原本で「－」＝未設定（電力会社ごとの実排出係数を別途使用）')
ON CONFLICT (fiscal_year, fuel_type) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('070_iso_energy_factors', now(), 'ISO14001 環境 エネルギー換算係数 seed（主要7種、電気CO2係数はNULL）') ON CONFLICT (version) DO NOTHING;
