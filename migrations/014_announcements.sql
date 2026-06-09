-- ============================================================
-- 014: 掲示板・お知らせ機能
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内ポータルに「お知らせ」機能を追加する。
--   - announcements: お知らせ本体（タイトル / 本文 / カテゴリ / 優先度 / 宛先種別 / ピン留め等）
--   - announcement_targets: 宛先が会社/部署指定の場合の対象値
--   - announcement_reads: 既読・確認状況の記録（到達率集計に使用）
--   RLS は他テーブルと同様にオフ（アプリ側の requireAuth で制御）。
-- ============================================================

-- ── 再実行を安全にするための初期化 ─────────────────────────────
DROP TABLE IF EXISTS announcement_reads   CASCADE;
DROP TABLE IF EXISTS announcement_targets CASCADE;
DROP TABLE IF EXISTS announcements        CASCADE;

-- ── 1) お知らせ本体 ────────────────────────────────────────────
CREATE TABLE announcements (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT,
  category      TEXT,                                   -- 例: 'info' | 'warning' | 'event' | 'rule' 等（自由文字列）
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  target_type   TEXT NOT NULL DEFAULT 'all'
                CHECK (target_type IN ('all', 'company', 'department')),
  is_pinned     BOOLEAN NOT NULL DEFAULT FALSE,          -- 常に先頭に表示
  requires_ack  BOOLEAN NOT NULL DEFAULT FALSE,          -- 確認（既読ボタン押下）を要求するか
  publish_at    TIMESTAMPTZ NOT NULL DEFAULT now(),      -- 公開日時（未来日付で予約投稿）
  expire_at     TIMESTAMPTZ,                             -- 掲載終了日時（NULL = 無期限）
  attachments   JSONB NOT NULL DEFAULT '[]'::JSONB,      -- 添付ファイル情報 [{name, url, size}]
  author_email  TEXT,                                    -- 作成者のメールアドレス
  author_name   TEXT,                                    -- 作成者の表示名
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,           -- 論理削除フラグ
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_publish_at ON announcements(publish_at);
CREATE INDEX IF NOT EXISTS idx_announcements_is_active  ON announcements(is_active);
CREATE INDEX IF NOT EXISTS idx_announcements_pinned     ON announcements(is_pinned, publish_at DESC);

-- ── 2) 宛先（会社 / 部署 指定の場合）─────────────────────────
-- kind: 'company'（staff_master.company に一致）| 'department'（staff_master.department に一致）
-- value: 対象の会社名 / 部署名（staff_master の値と突合）
CREATE TABLE announcement_targets (
  id              BIGSERIAL PRIMARY KEY,
  announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('company', 'department')),
  value           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_targets_announcement ON announcement_targets(announcement_id);

-- ── 3) 既読 / 確認記録 ─────────────────────────────────────────
CREATE TABLE announcement_reads (
  id              BIGSERIAL PRIMARY KEY,
  announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_email      TEXT NOT NULL,
  read_at         TIMESTAMPTZ,           -- 既読日時（NULL = 未読）
  acknowledged_at TIMESTAMPTZ,          -- 確認（ack）日時（NULL = 未確認）
  UNIQUE (announcement_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_ann_reads_announcement ON announcement_reads(announcement_id);
CREATE INDEX IF NOT EXISTS idx_ann_reads_user_email   ON announcement_reads(user_email);
