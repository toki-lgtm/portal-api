-- ============================================================
-- 058: ISO 測定機器（個体管理＋校正＋現場貸出）
-- 実行先: Supabase SQL Editor
-- 目的:
--   審査懸念No.3（7.1.5.1）＝オートレベル5台・トータルステーション3台に
--   個体識別(ナンバリング)がなく現場ごとの使用トレーサビリティが取れない、
--   への対応。個体番号(serial_no)＋現場貸出(loans)＋校正(calibrations)を管理。
--   出典: 019_測定機器管理表（校正周期1年/外注、オートレベル=森谷商会 直近2025-02-12、
--         トータルステーション=水上洋行 直近2025-07-01、担当=中原）。
--   RLS はオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_instrument_loans CASCADE;
DROP TABLE IF EXISTS iso_calibrations CASCADE;
DROP TABLE IF EXISTS iso_instruments CASCADE;

CREATE TABLE iso_instruments (
  id                       SERIAL PRIMARY KEY,
  serial_no                TEXT UNIQUE,          -- ★個体番号（ナンバリング）
  name                     TEXT NOT NULL,        -- オートレベル / トータルステーション 等
  model                    TEXT,                 -- 型番
  calibration_cycle_months INT,                  -- 校正周期(月)。NULL=対象外
  calibration_method       TEXT,                 -- 外注 / 内部
  vendor                   TEXT,                 -- 校正会社
  is_active                BOOLEAN NOT NULL DEFAULT true,
  note                     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iso_calibrations (
  id            SERIAL PRIMARY KEY,
  instrument_id INT NOT NULL REFERENCES iso_instruments(id) ON DELETE CASCADE,
  actual_date   DATE NOT NULL,              -- 校正実施日
  next_due_date DATE,                       -- 次回校正期限（実施日+周期）
  assignee      TEXT,
  cert_link     TEXT,                       -- 校正証明書PDF(Drive)へのリンク
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_calib_inst ON iso_calibrations(instrument_id);

CREATE TABLE iso_instrument_loans (
  id            SERIAL PRIMARY KEY,
  instrument_id INT NOT NULL REFERENCES iso_instruments(id) ON DELETE CASCADE,
  project_id    INT,                        -- 工事マスタ連携（無ければ site_name）
  site_name     TEXT,                       -- 貸出先現場名
  borrower      TEXT,                       -- 借用者
  loan_date     DATE NOT NULL,
  return_date   DATE,                       -- NULL=貸出中
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_loan_inst ON iso_instrument_loans(instrument_id);

-- ── seed: 審査対象の8個体（個体番号は暫定。現物ラベルに合わせてUIで変更可） ──
INSERT INTO iso_instruments (serial_no, name, calibration_cycle_months, calibration_method, vendor) VALUES
  ('AL-01','オートレベル（高さ）',12,'外注','森谷商会'),
  ('AL-02','オートレベル（高さ）',12,'外注','森谷商会'),
  ('AL-03','オートレベル（高さ）',12,'外注','森谷商会'),
  ('AL-04','オートレベル（高さ）',12,'外注','森谷商会'),
  ('AL-05','オートレベル（高さ）',12,'外注','森谷商会'),
  ('TS-01','トータルステーション（座標）',12,'外注','㈱水上洋行'),
  ('TS-02','トータルステーション（座標）',12,'外注','㈱水上洋行'),
  ('TS-03','トータルステーション（座標）',12,'外注','㈱水上洋行')
ON CONFLICT (serial_no) DO NOTHING;

-- 直近の校正実績（測定機器管理表より。オートレベル=2025-02-12 / TS=2025-07-01、担当 中原）
INSERT INTO iso_calibrations (instrument_id, actual_date, next_due_date, assignee)
SELECT id, DATE '2025-02-12', DATE '2026-02-12', '中原' FROM iso_instruments WHERE serial_no LIKE 'AL-%';
INSERT INTO iso_calibrations (instrument_id, actual_date, next_due_date, assignee)
SELECT id, DATE '2025-07-01', DATE '2026-07-01', '中原' FROM iso_instruments WHERE serial_no LIKE 'TS-%';

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('058_iso_instruments', now(), 'ISO 測定機器 個体管理+校正+貸出（懸念3）') ON CONFLICT (version) DO NOTHING;
