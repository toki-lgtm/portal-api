-- ============================================================
-- 094: iso_goals に「実施事項(a)」「必要な資源(b)」列を追加＋補完
-- 実行先: Supabase SQL Editor
-- 目的:
--   「これまでの書式」(6.2品質・労働安全目標達成計画書.docx)をPDF出力できるようにする準備。
--   原本docxの各目標ブロックは a.実施事項 / b.必要な資源 / c.責任者 / d.達成期限 /
--   e.評価方法 / f.事業プロセス の6項目だが、DBには c〜f しか無く a・b が欠落していた。
--   出典: G:\...\007_品質・労働安全目標達成計画書\6.2品質・労働安全目標達成計画書.docx
--   2025年度・2026年度いずれの同一目標にも同じ a・b を補完（2026は繰越のため同値）。
-- ============================================================

ALTER TABLE iso_goals ADD COLUMN IF NOT EXISTS action_items TEXT;  -- a. 実施事項
ALTER TABLE iso_goals ADD COLUMN IF NOT EXISTS resources    TEXT;  -- b. 必要な資源

-- 目標①: 労災ゼロ件
UPDATE iso_goals SET
  action_items = '決められた手順の順守。安全確認・指差呼称。KY活動。ヒヤリハット報告。',
  resources    = '空調服の購入（中原建設従業員全員分）。休憩所の設置・エアコン設置。塩飴設置。保護具の購入（ヘルメット、アスベスト用全身防護服）。'
WHERE title LIKE '%労災%';

-- 目標②: くるみんプラス認定及びＮぴか認定の維持
UPDATE iso_goals SET
  action_items = '（くるみん）女性不妊治療に伴う休暇取得、所定労働時間を5時間、時短勤務、男性育児休暇取得奨励。（Ｎぴか）ラジオ体操、ストレスチェック、テレワーク推進（PC貸与し、在宅勤務）。',
  resources    = 'PCの用意。'
WHERE title LIKE '%くるみん%';

-- 目標③: 施工管理技士資格保有者数・昨対20％増
UPDATE iso_goals SET
  action_items = '日建学院の講座受講、受験。',
  resources    = '日建学院の講座費用。'
WHERE title LIKE '%施工管理技士%';

-- 目標④: 公共工事における工事成績評定74点
UPDATE iso_goals SET
  action_items = '創意工夫（設計書に記載の無い項目）を各工事で実施。',
  resources    = '創意工夫に係る費用。'
WHERE title LIKE '%工事成績評定%';

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('094_iso_goals_add_action_resources', now(), 'iso_goalsにaction_items(実施事項)/resources(必要な資源)を追加し原本docxから全目標へ補完') ON CONFLICT (version) DO NOTHING;
