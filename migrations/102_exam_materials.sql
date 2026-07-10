-- ============================================================
-- 102: 資格学習アプリ — 教材（読み物）機能
-- 実行先: Supabase SQL Editor
-- 目的:
--   既存の資格学習アプリ(039_exam_prep)は「問題演習」だけだった。
--   これに、公式教本の本文を章立てで読める「教材（インプット学習）」を追加する。
--   まず J.S.A. ソムリエ／ワインエキスパート教本 2026年版(全809頁)を投入する。
--
--   権限は新設せず、既存の2層をそのまま流用する:
--     第1層 = staff_app_permissions['exam-prep']（アプリ自体へのアクセス）
--     第2層 = exam_subject_access（社員×科目。ワインは見れる/日本酒は見れない）
--   → 教材は subject_id で科目に紐づくだけで、既存の権限チェックがそのまま効く。
--
--   章立て（教本の章・節）は独自構造を持つ(問題の35章とは別体系になり得る)ため、
--   exam_materials 自身に chapter_no / chapter_title を持たせて独立成立させる。
--   将来「この章の問題を解く前に教材を読む」導線のため、問題側の章(exam_chapters)への
--   任意リンク linked_chapter_id も用意する(NULL可・無くても動く)。
-- ============================================================

DROP TABLE IF EXISTS exam_materials CASCADE;

CREATE TABLE exam_materials (
  id            BIGSERIAL PRIMARY KEY,
  subject_id    TEXT NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,

  -- 教本上の章（教材独自の章立て）
  chapter_no    INTEGER NOT NULL,            -- 章番号（教本の並び順）
  chapter_title TEXT NOT NULL,               -- 章タイトル: 'ワイン概論' 等

  -- 節（章内の読み物の単位。1節=1見出し+本文のかたまり）
  section_no    INTEGER NOT NULL,            -- 章内の節番号（並び順, 0=導入）
  heading       TEXT,                        -- 節見出し（章冒頭の導入文は NULL 可）
  body          TEXT NOT NULL,               -- 本文（プレーンテキスト）

  -- 出典・リンク
  src_page_start INTEGER,                    -- 出典PDF開始頁
  src_page_end   INTEGER,                    -- 出典PDF終了頁
  linked_chapter_id BIGINT REFERENCES exam_chapters(id) ON DELETE SET NULL, -- 問題章への任意リンク

  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (subject_id, chapter_no, section_no)
);
CREATE INDEX idx_exam_materials_subject         ON exam_materials(subject_id);
CREATE INDEX idx_exam_materials_subject_chapter ON exam_materials(subject_id, chapter_no, section_no);
