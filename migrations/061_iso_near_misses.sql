-- ============================================================
-- 061: ISO ヒヤリハット報告
-- 実行先: Supabase SQL Editor
-- 目的:
--   コンサル(柏原氏)が繰り返し「アプリ内報告」を指示した領域。目標=月30件。
--   現場担当者が素早く起票できる簡易フォーム。全社員が報告可（登録=requireAuth）、
--   編集・削除は管理者のみ。Googleスプレッドシート運用からの置き換え。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_near_misses CASCADE;
CREATE TABLE iso_near_misses (
  id           SERIAL PRIMARY KEY,
  report_date  DATE NOT NULL,
  reporter     TEXT,                 -- 報告者
  site_name    TEXT,                 -- 現場・場所
  category     TEXT,                 -- 種別（転倒/墜落/挟まれ/交通/その他 等・自由）
  content      TEXT NOT NULL,        -- ヒヤリハットの内容
  cause        TEXT,                 -- 推定原因
  measure      TEXT,                 -- 対策・気づき
  created_by   TEXT,                 -- 起票アカウント（email）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_nearmiss_date ON iso_near_misses(report_date DESC);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('061_iso_near_misses', now(), 'ISO ヒヤリハット報告（アプリ内報告・月30件目標）') ON CONFLICT (version) DO NOTHING;
