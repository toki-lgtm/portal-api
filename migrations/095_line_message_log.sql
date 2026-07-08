-- ============================================================
-- 095: LINEグループ記録（会社公式アカウントをグループに入れて全発言を記録）
-- 実行先: Supabase SQL Editor
-- 目的:
--   会社のグループLINEに会社公式アカウント(Messaging API bot)を参加させ、
--   グループ内の全発言(テキスト/写真/スタンプ/位置情報 等)を受信して蓄積する。
--   ★このテーブルは「一時受け皿」。恒久保存は共有ドライブ側で行う:
--     ・写真などのメディア実体は受信時に共有ドライブへ（drive_file_id に fileId を保持）
--     ・日次で1日ぶんを構造化CSVにして共有ドライブへ保存し、保存できた行は本テーブルから削除
--       （/api/line/daily-export）。→ クラウドDBに会話を溜め込まない設計。
--   受信(記録)は LINE の通数課金の対象外＝完全無料。催促(プッシュ)は将来別途。
--
--   冪等キー: LINE は webhook を再送することがあるため webhook_event_id を一意にして
--   二重登録を防ぐ（同一イベントの再送は無視）。
--   既存テーブルには一切触れない新規テーブル（低リスク）。
-- ============================================================

CREATE TABLE IF NOT EXISTS line_messages (
  id               BIGSERIAL PRIMARY KEY,
  webhook_event_id TEXT UNIQUE,        -- LINEイベントの一意ID（再送の冪等キー）
  event_type       TEXT NOT NULL,      -- message / join / leave / memberJoined / memberLeft ...
  message_type     TEXT,               -- text / image / video / audio / file / sticker / location ...
  source_type      TEXT,               -- group / room / user
  group_id         TEXT,               -- グループID（将来の催促の宛先にも使う）
  sender_user_id   TEXT,               -- 発言者のuserId
  sender_name      TEXT,               -- 表示名（getGroupMemberProfileで解決）
  text             TEXT,               -- テキスト本文（非テキストは [image] 等の要約）
  drive_file_id    TEXT,               -- 写真等を共有ドライブへ保存した場合の fileId
  file_name        TEXT,               -- 共有ドライブ上のファイル名
  sticker_info     TEXT,               -- スタンプの packageId / stickerId
  raw              JSONB,              -- 元イベント全体（後から何でも復元できるよう保全）
  sent_at          TIMESTAMPTZ,        -- LINEのtimestamp（発言時刻）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_messages_group_time ON line_messages (group_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_line_messages_created    ON line_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_line_messages_sender     ON line_messages (sender_user_id);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('095_line_message_log', now(), 'LINEグループ発言記録テーブル(line_messages)を新設。写真はDrive/本文はここ。webhook_event_idで冪等')
ON CONFLICT (version) DO NOTHING;
