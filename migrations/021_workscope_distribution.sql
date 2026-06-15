-- ============================================================
-- 021: WorkScope 配布（インストーラー配布 + 利用ログ）
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内ポータルを WorkScope（PC業務記録ツール）の配布入口にする。
--   - workscope_release:  配布中インストーラー（zip）のレジストリ。最新行＝現行版。
--   - workscope_downloads: 誰が・いつ・どの版をダウンロードしたかの利用ログ。
--   インストーラー本体は Supabase Storage バケット 'app-downloads' に置き、
--   release.file_path から署名URLを発行して配布する。
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth / requireAdmin で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS workscope_downloads CASCADE;
DROP TABLE IF EXISTS workscope_release   CASCADE;

-- ── 1) 配布中インストーラーのレジストリ ────────────────────────
--    管理者がポータルからアップロードするたびに1行追加。最新（uploaded_at 降順の先頭）が現行版。
CREATE TABLE workscope_release (
  id           BIGSERIAL PRIMARY KEY,
  version      TEXT NOT NULL,                       -- 表示用バージョン（例: 1.0.0）
  file_path    TEXT NOT NULL,                       -- Storage 'app-downloads' 内のパス
  file_size    BIGINT,                              -- ファイルサイズ（バイト）
  notes        TEXT,                                -- 変更点・備考（任意）
  uploaded_by  TEXT,                                -- アップロードした管理者のメール
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workscope_release_uploaded ON workscope_release(uploaded_at DESC);

-- ── 2) ダウンロード（＝導入）ログ ──────────────────────────────
--    「ポータル利用社員のうち誰が WorkScope を入れたか」を把握する一次ソース。
CREATE TABLE workscope_downloads (
  id          BIGSERIAL PRIMARY KEY,
  user_email  TEXT,                                 -- ダウンロードした社員のメール
  user_name   TEXT,                                 -- 表示名（JWT 由来）
  staff_id    TEXT,                                 -- staff_master 突合ID（未登録なら null）
  version     TEXT,                                 -- ダウンロード時点の配布版
  ip          TEXT,                                 -- 取得できれば送信元IP
  user_agent  TEXT,                                 -- ブラウザ情報
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workscope_dl_email   ON workscope_downloads(user_email);
CREATE INDEX IF NOT EXISTS idx_workscope_dl_created ON workscope_downloads(created_at DESC);
