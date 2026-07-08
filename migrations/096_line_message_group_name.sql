-- ============================================================
-- 096: line_messages にグループ名(group_name)を追加
-- 実行先: Supabase SQL Editor
-- 目的:
--   社内グループが複数あるため「どのグループの発言か」を人が読める形で残す。
--   group_id は Cxxxx… という記号なので、getGroupSummary で取得したグループ名を
--   受信時に各行へ保存する（＋共有ドライブもグループ名ごとのフォルダに分ける）。
--   既存行は group_name=NULL のまま（エクスポート時は group_id にフォールバック）。
-- ============================================================

ALTER TABLE line_messages ADD COLUMN IF NOT EXISTS group_name TEXT;

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('096_line_message_group_name', now(), 'line_messagesにgroup_name(グループ名)を追加。複数グループの識別用')
ON CONFLICT (version) DO NOTHING;
