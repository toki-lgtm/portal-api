-- ============================================================
-- 049: 会社カレンダー（公休日・計画有給）
-- 実行先: Supabase SQL Editor
-- 目的:
--   会社の年間公休日・計画有給休暇をポータルのカレンダーで表示する。
--   出典: 主税さん作成「主税確定2026.7～2027.7まで計画有給休暇一覧.xlsx」
--         （確定シート＝「これに入力あと1日」版, 2026.7〜2027.6）
--   kind: 'koushu'=公休日 / 'yukyu'=計画有給休暇
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth で制御）。
-- ============================================================

DROP TABLE IF EXISTS company_holidays CASCADE;

CREATE TABLE company_holidays (
  day        DATE PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('koushu','yukyu')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_holidays_day ON company_holidays(day);

-- ── 初期投入: 2026.7〜2027.6（公休日85日 + 計画有給5日） ─────────
INSERT INTO company_holidays (day, kind) VALUES
  ('2026-07-04','koushu'),
  ('2026-07-05','koushu'),
  ('2026-07-12','koushu'),
  ('2026-07-18','koushu'),
  ('2026-07-19','koushu'),
  ('2026-07-20','koushu'),
  ('2026-07-26','koushu'),
  ('2026-08-02','koushu'),
  ('2026-08-09','koushu'),
  ('2026-08-10','yukyu'),
  ('2026-08-11','koushu'),
  ('2026-08-12','yukyu'),
  ('2026-08-13','koushu'),
  ('2026-08-14','koushu'),
  ('2026-08-15','koushu'),
  ('2026-08-16','koushu'),
  ('2026-08-23','koushu'),
  ('2026-08-30','koushu'),
  ('2026-09-06','koushu'),
  ('2026-09-12','koushu'),
  ('2026-09-13','koushu'),
  ('2026-09-20','koushu'),
  ('2026-09-21','koushu'),
  ('2026-09-22','koushu'),
  ('2026-09-23','koushu'),
  ('2026-09-27','koushu'),
  ('2026-10-04','koushu'),
  ('2026-10-10','koushu'),
  ('2026-10-11','koushu'),
  ('2026-10-12','koushu'),
  ('2026-10-18','koushu'),
  ('2026-10-25','koushu'),
  ('2026-11-01','koushu'),
  ('2026-11-08','koushu'),
  ('2026-11-15','koushu'),
  ('2026-11-21','koushu'),
  ('2026-11-22','koushu'),
  ('2026-11-23','koushu'),
  ('2026-11-29','koushu'),
  ('2026-12-06','koushu'),
  ('2026-12-13','koushu'),
  ('2026-12-20','koushu'),
  ('2026-12-27','koushu'),
  ('2026-12-28','yukyu'),
  ('2026-12-29','koushu'),
  ('2026-12-30','koushu'),
  ('2026-12-31','koushu'),
  ('2027-01-01','koushu'),
  ('2027-01-02','koushu'),
  ('2027-01-03','koushu'),
  ('2027-01-04','koushu'),
  ('2027-01-05','koushu'),
  ('2027-01-10','koushu'),
  ('2027-01-17','koushu'),
  ('2027-01-24','koushu'),
  ('2027-01-31','koushu'),
  ('2027-02-07','koushu'),
  ('2027-02-13','koushu'),
  ('2027-02-14','koushu'),
  ('2027-02-21','koushu'),
  ('2027-02-28','koushu'),
  ('2027-03-07','koushu'),
  ('2027-03-14','koushu'),
  ('2027-03-20','koushu'),
  ('2027-03-21','koushu'),
  ('2027-03-22','koushu'),
  ('2027-03-28','koushu'),
  ('2027-04-03','koushu'),
  ('2027-04-04','koushu'),
  ('2027-04-11','koushu'),
  ('2027-04-17','koushu'),
  ('2027-04-18','koushu'),
  ('2027-04-25','koushu'),
  ('2027-04-29','koushu'),
  ('2027-04-30','yukyu'),
  ('2027-05-01','yukyu'),
  ('2027-05-02','koushu'),
  ('2027-05-03','koushu'),
  ('2027-05-04','koushu'),
  ('2027-05-05','koushu'),
  ('2027-05-09','koushu'),
  ('2027-05-16','koushu'),
  ('2027-05-23','koushu'),
  ('2027-05-30','koushu'),
  ('2027-06-06','koushu'),
  ('2027-06-12','koushu'),
  ('2027-06-13','koushu'),
  ('2027-06-20','koushu'),
  ('2027-06-26','koushu'),
  ('2027-06-27','koushu')
ON CONFLICT (day) DO NOTHING;
