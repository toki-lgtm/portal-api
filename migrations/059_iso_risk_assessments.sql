-- ============================================================
-- 059: ISO リスクアセスメント表（場所軸つき）
-- 実行先: Supabase SQL Editor
-- 目的:
--   審査懸念No.4（6.1.1）＝認証範囲の「資材置場」「駐車場」のリスクアセスメント
--   記録がない、への対応。場所(location_id)軸を持たせ、資材置場・駐車場を登録。
--   評価点=発生頻度+重大性（生成列）、5点以上で重点管理（生成列）。
--   管理策コード A除去/B代替/C工学的/D標識教育/E保護具。
--   出典: 005_リスクアセスメント表「資材置場、駐車場」シート（3行）。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_risk_assessments CASCADE;
CREATE TABLE iso_risk_assessments (
  id            SERIAL PRIMARY KEY,
  location_id   SMALLINT REFERENCES iso_locations(id),   -- ★場所軸（懸念4）
  dept          TEXT,                        -- 部門
  process       TEXT,                        -- 工程・工種
  hazard        TEXT NOT NULL,               -- 危険源
  scene         TEXT,                        -- どこで・どんな場面で
  damage        TEXT,                        -- どんな事故・災害
  measures      TEXT,                        -- 現在の対策（①②③）
  control_codes TEXT,                        -- 管理策コード A-E（改行/スラッシュ区切り）
  frequency     SMALLINT CHECK (frequency BETWEEN 1 AND 3),
  severity      SMALLINT CHECK (severity  BETWEEN 1 AND 3),
  score         SMALLINT GENERATED ALWAYS AS (frequency + severity) STORED,
  priority_flag BOOLEAN  GENERATED ALWAYS AS ((frequency + severity) >= 5) STORED,
  legal_flag    BOOLEAN NOT NULL DEFAULT false,
  category      TEXT NOT NULL DEFAULT 'risk' CHECK (category IN ('risk','opportunity')),
  review_date   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_ra_loc  ON iso_risk_assessments(location_id);
CREATE INDEX idx_iso_ra_dept ON iso_risk_assessments(dept);

-- ── seed: 資材置場・駐車場（location_id=2 資材置場。駐車場含む一体評価） ──
INSERT INTO iso_risk_assessments
  (location_id, process, hazard, scene, damage, measures, control_codes, frequency, severity) VALUES
  (2, '資材置場・駐車場', '重機・車両', '車両運転時',
   '接触・巻き込みによる負傷・打撲・骨折',
   E'①重機・車両運転時の周囲への立入禁止\n②前後左右の目視確認\n③防護具の着用（ヘルメット等）',
   'C/D/E', 1, 2),
  (2, '資材置場・駐車場', '資材', '保管場所への積み上げ時、または荷卸し時',
   '落下物による負傷・打撲・骨折',
   E'①重量の遵守\n②荷崩れ防止措置（ベルト・ロープ等）\n③防護具の着用（ヘルメット、手袋等）',
   'D/C/E', 1, 2),
  (2, '資材置場・駐車場', '資材（廃棄物）', '倉庫内の整理整頓時／不要物の焼却時',
   '躓いて転倒／木片・ガラス片等で切創／火傷',
   E'①通路の確保\n②落下防止措置（ベルト・ロープ等）\n③焼却炉と距離を保つ\n④防護具の着用（ヘルメット、手袋等）',
   'C/C/C/E', 1, 2);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('059_iso_risk_assessments', now(), 'ISO リスクアセス 場所軸（懸念4・資材置場駐車場seed）') ON CONFLICT (version) DO NOTHING;
