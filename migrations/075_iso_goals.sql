-- ============================================================
-- 075: ISO 目標達成計画（品質・労働安全衛生・環境）＋ 月次進捗
-- 実行先: Supabase SQL Editor
-- 目的:
--   6.2品質・労働安全衛生目標達成計画書のアプリ化。年度ごとの目標(親)と
--   月次の結果・評価(子)を分離管理。閲覧=全社員、編集=管理者のみ。
--   出典: G:\...\007_品質・労働安全目標達成計画書\6.2品質・労働安全目標達成計画書.docx
--   2025年度の目標4本を実値でseed（責任者・評価方法・事業プロセスも原本のまま）。
--   RLS はオフ（アプリ側で制御）。
-- ============================================================

DROP TABLE IF EXISTS iso_goal_progress CASCADE;
DROP TABLE IF EXISTS iso_goals CASCADE;

CREATE TABLE iso_goals (
  id           SERIAL PRIMARY KEY,
  fiscal_year  TEXT NOT NULL,           -- 例: '2025'
  category     TEXT NOT NULL CHECK (category IN ('品質', '労働安全衛生', '環境')),
  title        TEXT NOT NULL,
  target       TEXT,                    -- 数値目標
  baseline     TEXT,                    -- 現状
  owner        TEXT,                    -- 責任者
  deadline     TEXT,                    -- 達成期限
  eval_method  TEXT,                    -- 評価方法
  ms_clause    TEXT,                    -- 事業プロセス（規格条項）
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_goals_fy ON iso_goals(fiscal_year);

CREATE TABLE iso_goal_progress (
  id         SERIAL PRIMARY KEY,
  goal_id    INT NOT NULL REFERENCES iso_goals(id) ON DELETE CASCADE,
  ym         TEXT NOT NULL,             -- 'YYYY-MM'
  result     TEXT,                      -- 実施月の結果
  evaluation TEXT,                      -- 評価者コメント
  evaluator  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iso_goal_progress_goal ON iso_goal_progress(goal_id, ym);

-- 2025年度 目標4本（原本docxより実値seed）
INSERT INTO iso_goals (fiscal_year, category, title, target, baseline, owner, deadline, eval_method, ms_clause, sort_order) VALUES
(
  '2025', '労働安全衛生',
  '労災ゼロ件',
  '労災ゼロ件',
  '現状3～4件/年、車両接触、工具による切り傷。熱中症疑い3件/年',
  '中原釈統（安全・衛生管理者）',
  '通期（1年）',
  '安全衛生委員会で、3か月1回データを評価しフィードバック。指標として、ヒヤリハットの収集数（30件/月）',
  '6.2（リスクアセスメント）、8.1（運用）',
  1
),
(
  '2025', '労働安全衛生',
  'くるみんプラス認定及びＮぴか認定の維持',
  'くるみんプラス認定及びＮぴか認定の維持。社内制度の維持。',
  '両認定を取得済・維持段階',
  '中原里加',
  '通期（1年）',
  '安全衛生委員会で、年1回データを評価しフィードバック。指標として、これらの制度利用者の報告。',
  '7.1.4（作業環境）',
  2
),
(
  '2025', '品質',
  '施工管理技士資格保有者数・昨対20％増',
  '昨対20％増（今年は施工管理技士11名、技士補11名。1級建築1次2名2次2名／2級建築2次1名／1級土木2次2名／2級土木1次1名2次2名／1級建設機械1次1名2次1名／2級建設機械1次2名／1級管工事1次2名／2級管工事1次1名／1級電気工事1次2名）',
  '施工管理技士11名、技士補11名',
  '中原釈統',
  '試験期間6－11月（結果は翌年1～2月）',
  '指標は、目標人数に対して最低限８０％の達成。',
  '7.2（力量）',
  3
),
(
  '2025', '品質',
  '公共工事における工事成績評定74点',
  '工事成績評定74点',
  '2024年工事毎の平均点数72点',
  '中原釈統',
  '通期（2025年12月）',
  '指標は創意工夫の実績報告。',
  '9.1.2（顧客満足）',
  4
);

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('075_iso_goals', now(), 'ISO 目標達成計画＋月次進捗（2025年度4目標を原本docxからseed）') ON CONFLICT (version) DO NOTHING;
