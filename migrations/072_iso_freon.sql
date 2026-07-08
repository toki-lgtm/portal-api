-- ============================================================
-- 072: ISO14001 環境 フロン簡易点検（機器＋点検記録）
-- 実行先: Supabase SQL Editor
-- 目的:
--   フロン排出抑制法の簡易点検（3か月に1回）を機器ごとに記録する。
--   親=機器台帳、子=点検記録（振動/油/損傷/霜付き の4項目○×＋対応）。
--   seedデータなし（現有機器は運用開始時に登録）。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_freon_inspections CASCADE;
DROP TABLE IF EXISTS iso_freon_equipment CASCADE;

CREATE TABLE iso_freon_equipment (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,               -- 機器名（例: 事務所エアコン室外機）
  location     TEXT,                        -- 設置場所
  unit_no      TEXT,                        -- 管理番号・号機
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iso_freon_inspections (
  id               SERIAL PRIMARY KEY,
  equipment_id     INT NOT NULL REFERENCES iso_freon_equipment(id) ON DELETE CASCADE,
  inspect_date     DATE NOT NULL,
  inspector        TEXT,
  check_vibration  TEXT CHECK (check_vibration IN ('○', '×') OR check_vibration IS NULL), -- 異常な振動
  check_oil        TEXT CHECK (check_oil       IN ('○', '×') OR check_oil       IS NULL), -- 油にじみ
  check_damage     TEXT CHECK (check_damage    IN ('○', '×') OR check_damage    IS NULL), -- 配管損傷
  check_frost      TEXT CHECK (check_frost     IN ('○', '×') OR check_frost     IS NULL), -- 着霜・氷結
  response         TEXT,                        -- ×があった場合の対応
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_freon_insp_equipment ON iso_freon_inspections(equipment_id);
CREATE INDEX idx_iso_freon_insp_date      ON iso_freon_inspections(inspect_date DESC);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('072_iso_freon', now(), 'ISO14001 フロン簡易点検（機器台帳+3か月点検記録、seedなし）') ON CONFLICT (version) DO NOTHING;
