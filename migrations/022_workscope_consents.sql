-- ============================================================
-- 022: WorkScope 同意の中央記録
-- 実行先: Supabase SQL Editor
-- 目的:
--   WorkScope 導入時の利用規約同意を「誰が・いつ・どの版に」同意したか
--   サーバ側に残す（社員PCの config.json だけでなく中央に証跡を持つ）。
--   ポータルの導入モーダル/導入ページでダウンロード前に同意を記録する。
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth / 権限解決で制御）。
-- ============================================================

DROP TABLE IF EXISTS workscope_consents CASCADE;

CREATE TABLE workscope_consents (
  id           BIGSERIAL PRIMARY KEY,
  user_email   TEXT,                                 -- 同意した社員のメール
  user_name    TEXT,                                 -- 表示名（社員一覧優先 / Googleアカウント名）
  staff_id     TEXT,                                 -- staff_master 突合ID（未登録なら null）
  eula_version TEXT,                                 -- 同意した規約の版（例: 2026-06-15）
  ip           TEXT,                                 -- 取得できれば送信元IP
  user_agent   TEXT,                                 -- ブラウザ情報
  agreed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workscope_consents_email  ON workscope_consents(user_email);
CREATE INDEX IF NOT EXISTS idx_workscope_consents_agreed ON workscope_consents(agreed_at DESC);
