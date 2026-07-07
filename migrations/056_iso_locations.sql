-- ============================================================
-- 056: ISO管理 場所マスタ（認証範囲の拠点）
-- 実行先: Supabase SQL Editor
-- 目的:
--   ISO認証範囲の拠点をマスタ化。以降の記録（リスクアセスメント・自主検査・
--   巡視等）を場所単位で紐付ける土台。
--   認証範囲＝本社／資材置場／駐車場／福岡支社の4拠点（福岡支社は今回
--   すべての規格で範囲内：9001/45001は追加、14001は新規）。
--   RLS は他テーブルと同様にオフ（アプリ側 requireAuth/requireAdmin で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_locations CASCADE;

CREATE TABLE iso_locations (
  id          SMALLINT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('office','yard','parking','branch')),
  in_scope_q  BOOLEAN NOT NULL DEFAULT true,   -- 9001 品質 範囲内
  in_scope_s  BOOLEAN NOT NULL DEFAULT true,   -- 45001 労働安全衛生 範囲内
  in_scope_e  BOOLEAN NOT NULL DEFAULT true,   -- 14001 環境 範囲内
  address     TEXT,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO iso_locations (id, name, kind, address, sort_order) VALUES
  (1, '本社',     'office',  '長崎県対馬市峰町吉田186-1', 1),
  (2, '資材置場', 'yard',    NULL,                         2),
  (3, '駐車場',   'parking', NULL,                         3),
  (4, '福岡支社', 'branch',  '福岡市博多区豊2-6-1',       4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('056_iso_locations', now(), 'ISO管理 場所マスタ（4拠点）') ON CONFLICT (version) DO NOTHING;
