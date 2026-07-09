-- ============================================================
-- 099: ISO 文書記録台帳 → 保管庫フォルダのGoogleドライブリンク付与
-- 実行先: Supabase SQL Editor
-- 目的:
--   文書記録台帳(057)の各行に、実体が保管されている「01_ＩＳＯ文書記録保管庫」の
--   該当フォルダ(000〜058)へのGoogleドライブWebリンクをstorageLinkとして設定する。
--   これで台帳のタイトルをクリック→ブラウザでそのフォルダ(実物の記録)が開く。
--   ・リンクはフォルダURL(https://drive.google.com/drive/folders/<id>)。
--     フォルダ内に版違い/複数ファイルがあるため単ファイルでなくフォルダを開く。
--   ・開くには各自のGoogle Workspaceログインが必要（社員は全員該当）。
--   ・対象は保管庫に中央フォルダを持つ39行。竣工工事各種記録側(工事ごと別保管)の
--     18行はここでは対象外（各工事フォルダに分散し中央フォルダが無いため）。
--   フォルダIDは 2026-07-09 にサービスアカウントでライブ取得（_gen_iso_storage_links.mjs）。
-- ============================================================

UPDATE iso_documents AS d SET
  category_no  = m.cat,
  storage_link = 'https://drive.google.com/drive/folders/' || m.fid,
  updated_at   = now()
FROM (VALUES
  (1, '001', '1hy-z0D50GKeDqOhOcuwvTGhe1H5oZho2'),
  (2, '002', '1Io9zPsvnstfppdSCo2VV7AUiuaAQyTq5'),
  (3, '003', '1tXdgz3a5lFUog6mmuYgBmeICd0iPrkWo'),
  (4, '004', '171Wi2BjbfRnNXLZPLmGrqHANKpd2SBtA'),
  (5, '005', '1gEW9WnZ_M3FRQIS8-0k-QW8gxTjQu51n'),
  (6, '006', '1oGGWCjeaSu4_xSh1ZiQE6IyWJTtn03QE'),
  (7, '007', '10rGtPDAxw2BLjrtaZgy9l-lXKD-mzW_8'),
  (8, '008', '1gXoNoVpJ516yvl61yzYatq743SzaCKrV'),
  (9, '009', '1XgrkrBOYgV7gWXrPfGNMpcm6mbXCb9MM'),
  (10, '010', '17QNiiFTKTTpOrCUFBEwpXtECxnBYn8De'),
  (11, '011', '1X8pstnPYDvEQT9pq1FjTz1nd_AOwOlOZ'),
  (12, '012', '1TvUiJcAbT5FfSw59Ev6Tefm2ciRDYlc7'),
  (13, '013', '1gN_qvP5dxMMmoZKJiF2TdQpqpqnocG4o'),
  (14, '014', '15pdZ1QgJW0bYBa-MVRminp6d7RMOsyND'),
  (15, '015', '1XUbL9CmDBVjr7kJfrbL0660FqLLkQ7UU'),
  (16, '016', '1mF9tS7Ao1_la3l9OfEa81-QMykMKE6uW'),
  (17, '016', '1CbVmw7Y8GB9teqdTifGIDniRmz36cvEk'),
  (18, '018', '1V4ZE68Qi4GUHAHviRVc2FhEJCTEYwE2I'),
  (19, '019', '1ghtFo6onYONuTTxKhBXtFBWHhHqrVOWe'),
  (20, '020', '1_5wlPgDyAH8dlEizVi6ZKwwtO0DCLlcZ'),
  (21, '021', '1yLDJbhZWCw0SZmRELMow0X8I-h0FPFaE'),
  (22, '022', '19GUXvZKOY6iat-9vPO5J-4p5o3T_EGGh'),
  (23, '023', '1yeyICdK0EVk8TXhW3ZcjqM_vUZxvz5hl'),
  (24, '024', '1tGa6QkwMj8JRkAHG1_uXgouTyRnTgNcE'),
  (25, '025', '1_VpIrCyijPh-adxTaPDAJQD-9STPhth3'),
  (32, '032', '1aKCq-3lh02LYeYYdcZu-D-IfbaWGx9jW'),
  (36, '036', '1R1tr5x6G0_xCCYnHExAlxReW9ZNVDjRf'),
  (44, '044', '1bug1ubx0Awh0wQDV-dk4tVBlR0gXxtwf'),
  (45, '045', '1LZH95RIGsd4ljaBoNPly4R0HRts0ZDZg'),
  (47, '047', '1RjvWp7rzEBOtqPRpiVVQ9OjzLLwfi9Mv'),
  (48, '048', '1duX03-jF4taxouGTmvadGsuS4vxUuI6h'),
  (49, '049', '1zfI-qWILACTbO0OeWGqnkBhEbxO1WAhg'),
  (51, '051', '1ViJKnJ0CZqbdZMtT3HbvllqhaNyzBDtQ'),
  (52, '052', '1TaGVsV_Xprn93y6eZFKbegYCNySxgE2Q'),
  (53, '053', '1Is4KjmmzhtZAVqt1GFlllCzsXhaRDb8M'),
  (54, '054', '1aHdekBpEV_G4zcXe8RpgxCPL0jl5y4H9'),
  (55, '055', '11v9cSUUVkP9u12tLYAX2oZGiBiu2GZgW'),
  (56, '056', '1lrS2sLIQcIW6oR4-E4xo6lJldUBAtnMU'),
  (57, '057', '1UnHPNNkE7zck5YWR--EX2QQo28KEZ3E8')
) AS m(sort, cat, fid)
WHERE d.sort_order = m.sort;

INSERT INTO schema_migrations (version, applied_at, note)
VALUES ('099_iso_document_storage_links', now(), 'ISO文書記録台帳 保管庫フォルダのDriveリンク付与(39行)') ON CONFLICT (version) DO NOTHING;
