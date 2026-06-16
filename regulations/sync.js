// ============================================================
// 法令取込パイプライン
//
// 実行方法:
//   node regulations/sync.js --core    # CORE_LAWS を全件取込
//   node regulations/sync.js --sweep   # SWEEP_CATEGORIES を広域取込（Phase 4 用骨組み）
//
// 処理フロー:
//   1. e-Gov /laws で law_title + law_type から law_id を解決
//   2. /law_data でXML取得 → lawXmlParser でパース
//   3. 原本XMLを Google Drive へ保存（driveConfigured() が false ならスキップ）
//   4. regulations_law を upsert
//   5. regulations_article を法令ごとに全削除 → 一括insert
//   6. regulations_revision を /law_revisions から投入
//   7. 体系リンク（本法⇔施行令・規則）を regulations_reference に投入
//
// 冪等性: 再実行しても重複しない（law_id UNIQUE / article 全削除→再insert）。
// 本番では月次 cron から実行する想定。
// ============================================================

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

import {
  CORE_LAWS,
  SWEEP_CATEGORIES,
  SWEEP_LAW_TYPES,
  ENFORCEMENT_SUFFIXES,
  CATEGORY_LABELS,
  LAW_TYPE_LABELS,
  EGOV_API_BASE,
  EGOV_REQUEST_DELAY_MS,
  DRIVE_ROOT_SEGMENTS,
  DRIVE_SUBDIRS,
  SOURCE_ATTRIBUTION,
} from './catalog.js';

import { parseLawResponse } from './lawXmlParser.js';
import {
  driveUpload,
  driveConfigured,
  ensureFolderPath,
} from '../googleDrive.js';

dotenv.config();

// ── Supabase クライアント（emailDigest.js と同じ初期化方式）──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { global: { headers: { 'x-client-info': 'portal-api-regulations-sync' } }, realtime: { transport: ws } }
);

// ── コマンドライン引数 ──
const args = process.argv.slice(2);
const MODE_CORE = args.includes('--core');
const MODE_SWEEP = args.includes('--sweep');
// --only=<法令名の一部> で対象を絞って投入（特定法令だけ再取込する用途）
const ONLY_ARG = args.find(a => a.startsWith('--only='));
const ONLY_FILTER = ONLY_ARG ? ONLY_ARG.slice('--only='.length) : null;

if (!MODE_CORE && !MODE_SWEEP) {
  console.error('[sync] 実行モードを指定してください: --core または --sweep');
  process.exit(1);
}

// ── 進捗カウンタ ──
const stats = {
  laws: 0,
  articles: 0,
  revisions: 0,
  skipped: 0,
  errors: 0,
};

// ── ユーティリティ ────────────────────────────────────────────

/** 指定ミリ秒待機 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * e-Gov API を fetch する共通ラッパー。
 * Content-Type が JSON の場合は .json() を返す（それ以外は .text()）。
 */
async function egov(path, isJson = true) {
  const url = `${EGOV_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Accept: isJson ? 'application/json' : '*/*' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`e-Gov API エラー (${res.status}): ${path}\n${body.slice(0, 200)}`);
  }
  return isJson ? res.json() : res.text();
}

/**
 * law_title + law_type の組み合わせで e-Gov から law_id を解決する。
 * 完全一致 → 前方一致の順で試みる。
 * @returns {{ law_id: string, law_title: string, law_num: string,
 *             law_type: string, promulgation_date: string|null,
 *             enforcement_date: string|null, revision_id: string|null }|null}
 */
async function resolveLawId(lawTitle, lawType) {
  await sleep(EGOV_REQUEST_DELAY_MS);
  const encoded = encodeURIComponent(lawTitle);
  const path = `/laws?law_title=${encoded}&law_type=${lawType}&response_format=json`;

  let data;
  try {
    data = await egov(path);
  } catch (e) {
    console.warn(`  [warn] law_id 解決失敗 (${lawTitle}): ${e.message}`);
    return null;
  }

  const laws = data.laws || [];
  if (laws.length === 0) {
    console.warn(`  [warn] 法令が見つかりません: ${lawTitle} (${lawType})`);
    return null;
  }

  // 完全一致を優先
  const exactMatch = laws.find(l => {
    const title = l.revision_info?.law_title || l.current_revision_info?.law_title || '';
    return title === lawTitle;
  });
  const entry = exactMatch || laws[0];

  const lawInfo = entry.law_info || {};
  const revInfo = entry.revision_info || entry.current_revision_info || {};

  // processOneLaw が受け取る spec の camelCase キーに合わせて返す
  return {
    lawId: lawInfo.law_id || '',
    lawTitle: revInfo.law_title || lawTitle,
    lawNum: lawInfo.law_num || '',
    lawType: lawInfo.law_type || lawType,
    promulgationDate: lawInfo.promulgation_date || null,
    enforcementDate: revInfo.amendment_enforcement_date || null,
    currentRevisionId: revInfo.law_revision_id || null,
  };
}

/**
 * e-Gov /law_data から XML を取得してパースする。
 * @returns {{ parsed: object, rawXml: string }|null}
 */
async function fetchAndParseLaw(lawId) {
  await sleep(EGOV_REQUEST_DELAY_MS);
  let data;
  try {
    data = await egov(`/law_data/${encodeURIComponent(lawId)}?law_full_text_format=xml`);
  } catch (e) {
    console.warn(`  [warn] XML取得失敗 (${lawId}): ${e.message}`);
    return null;
  }

  // Base64デコードして生XMLも保持（Drive保存用）
  const rawXml = Buffer.from(data.law_full_text, 'base64').toString('utf-8');
  const parsed = parseLawResponse(data);
  return { parsed, rawXml };
}

/**
 * 改正履歴を /law_revisions から取得して regulations_revision 形式の配列を返す。
 */
async function fetchRevisions(lawId) {
  await sleep(EGOV_REQUEST_DELAY_MS);
  let data;
  try {
    data = await egov(`/law_revisions/${encodeURIComponent(lawId)}?response_format=json`);
  } catch (e) {
    console.warn(`  [warn] 改正履歴取得失敗 (${lawId}): ${e.message}`);
    return [];
  }

  const revisions = data.revisions || [];
  return revisions.map(r => {
    // current_revision_status: "CurrentEnforced" / "PreviousEnforced" / その他
    const status = r.current_revision_status;
    let revision_status = null;
    if (status === 'CurrentEnforced') revision_status = 'current';
    else if (status === 'PreviousEnforced') revision_status = 'expired';
    else if (status) revision_status = 'future';

    return {
      revision_id: r.law_revision_id || '',
      enforcement_date: r.amendment_enforcement_date || null,
      amendment_law_num: r.amendment_law_num || null,
      amendment_law_title: r.amendment_law_title || null,
      revision_status,
      summary: null,
    };
  }).filter(r => r.revision_id);
}

/**
 * 原本XMLを Google Drive に保存し file_ref を返す。
 * Drive未設定の場合は null を返して警告する（処理は継続）。
 */
async function saveXmlToDrive(lawTitle, lawId, xmlBuffer) {
  if (!driveConfigured()) {
    console.warn('  [warn] Drive未設定 - XML保存をスキップします。DB投入は継続。');
    return null;
  }
  try {
    const folderId = await ensureFolderPath([...DRIVE_ROOT_SEGMENTS, DRIVE_SUBDIRS.xml]);
    const fileName = `${lawId}_${new Date().toISOString().slice(0, 10)}.xml`;
    const fileId = await driveUpload({
      name: fileName,
      buffer: xmlBuffer,
      mimeType: 'application/xml',
      folderId,
    });
    return `drive:${fileId}`;
  } catch (e) {
    console.warn(`  [warn] Drive保存失敗 (${lawTitle}): ${e.message}`);
    return null;
  }
}

/**
 * 分類コードから表示ラベルを生成する。
 * カタログの category 配列 → CATEGORY_LABELS で解決。
 */
function buildCategoryLabels(categoryCodes) {
  return (categoryCodes || []).map(cd => CATEGORY_LABELS[cd] || cd);
}

// ── Supabase 操作 ─────────────────────────────────────────────

/**
 * regulations_law を upsert して DB上の id（BIGINT）を返す。
 */
async function upsertLaw({
  lawId, lawNum, title, titleKana, abbrev,
  lawType, categoryCds, enforcementDate, promulgationDate,
  currentRevisionId, repealStatus, parentLawDbId, relationType,
  xmlFileRef, sourceUrl, articleCount, isCore,
}) {
  const row = {
    law_id: lawId,
    law_num: lawNum || null,
    title,
    title_kana: titleKana || null,
    abbrev: abbrev || null,
    law_type: lawType || null,
    law_type_label: LAW_TYPE_LABELS[lawType] || null,
    category_cd: categoryCds || [],
    category_labels: buildCategoryLabels(categoryCds),
    parent_law_id: parentLawDbId || null,
    relation_type: relationType || 'self',
    promulgation_date: promulgationDate || null,
    enforcement_date: enforcementDate || null,
    current_revision_id: currentRevisionId || null,
    repeal_status: repealStatus || null,
    is_current: true,
    is_core: isCore,
    xml_file_ref: xmlFileRef || null,
    source_url: sourceUrl,
    article_count: articleCount,
    fetched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('regulations_law')
    .upsert(row, { onConflict: 'law_id' })
    .select('id')
    .single();

  if (error) throw new Error(`regulations_law upsert 失敗 (${lawId}): ${error.message}`);
  return data.id;
}

/**
 * regulations_article を法令ごとに全削除 → 一括 insert する。
 * 再実行で重複しないよう DELETE → INSERT の2段構成にする。
 */
async function replaceArticles(lawDbId, articles) {
  // 全削除
  const { error: delErr } = await supabase
    .from('regulations_article')
    .delete()
    .eq('law_id', lawDbId);
  if (delErr) throw new Error(`regulations_article 削除失敗 (law_id=${lawDbId}): ${delErr.message}`);

  if (articles.length === 0) return;

  // 一括 insert（_refs は DB カラムではないので除去）
  const rows = articles.map(a => ({
    law_id: lawDbId,
    division: a.division,
    suppl_label: a.suppl_label,
    part_num: a.part_num,
    part_title: a.part_title,
    chapter_num: a.chapter_num,
    chapter_title: a.chapter_title,
    section_num: a.section_num,
    section_title: a.section_title,
    subsection_num: a.subsection_num,
    subsection_title: a.subsection_title,
    article_num: a.article_num,
    article_caption: a.article_caption,
    content: a.content,
    sort_order: a.sort_order,
  }));

  // Supabase の insert は最大 1000 件推奨。大きい法令は分割する。
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: insErr } = await supabase
      .from('regulations_article')
      .insert(chunk);
    if (insErr) throw new Error(`regulations_article insert 失敗 (law_id=${lawDbId}): ${insErr.message}`);
  }
}

/**
 * regulations_revision を法令ごとに upsert する。
 * UNIQUE(law_id, revision_id) なので同じリビジョンは更新される。
 */
async function upsertRevisions(lawDbId, revisions) {
  if (revisions.length === 0) return;
  const rows = revisions.map(r => ({
    law_id: lawDbId,
    revision_id: r.revision_id,
    enforcement_date: r.enforcement_date,
    amendment_law_num: r.amendment_law_num,
    amendment_law_title: r.amendment_law_title,
    revision_status: r.revision_status,
    summary: r.summary,
  }));
  const { error } = await supabase
    .from('regulations_revision')
    .upsert(rows, { onConflict: 'law_id,revision_id' });
  if (error) throw new Error(`regulations_revision upsert 失敗: ${error.message}`);
}

/**
 * 体系リンク（本法⇔施行令・施行規則）を regulations_reference に投入する。
 * from_law_id = 施行令/規則, to_law_id = 本法 の双方向で記録する。
 * 既存の enforcement リンクは法令単位で先に全削除してから再投入する。
 */
async function upsertEnforcementRef(childLawDbId, parentLawDbId, childTitle) {
  // 既存の enforcement リンクを削除
  await supabase
    .from('regulations_reference')
    .delete()
    .eq('from_law_id', childLawDbId)
    .eq('ref_type', 'enforcement');

  const { error } = await supabase
    .from('regulations_reference')
    .insert({
      from_law_id: childLawDbId,
      from_article_id: null,
      to_law_id: parentLawDbId,
      to_law_title: null,
      to_article_num: null,
      ref_text: childTitle,
      ref_type: 'enforcement',
    });
  if (error) throw new Error(`regulations_reference (enforcement) insert 失敗: ${error.message}`);
}

// ── 1法令を処理する共通ロジック ──────────────────────────────

/**
 * 1つの法令を e-Gov から取得して Supabase + Drive に投入する。
 * @param {{
 *   lawId: string, lawTitle: string, lawNum: string,
 *   lawType: string, promulgationDate: string|null,
 *   enforcementDate: string|null, currentRevisionId: string|null,
 *   categoryCds: string[], isCore: boolean,
 *   parentLawDbId: number|null, relationType: string,
 * }} spec
 * @returns {number} DB上の id（次の法令の parent_law_id に使う）
 */
async function processOneLaw(spec) {
  const {
    lawId, lawTitle, lawNum, lawType,
    promulgationDate, enforcementDate, currentRevisionId,
    categoryCds, isCore, parentLawDbId, relationType,
  } = spec;

  console.log(`  → 取得中: ${lawTitle} (${lawId})`);

  // XML 取得・パース
  const result = await fetchAndParseLaw(lawId);
  if (!result) {
    stats.skipped++;
    // XMLが取れなくてもメタだけで upsert しておく
    const dbId = await upsertLaw({
      lawId, lawNum, title: lawTitle, lawType, categoryCds,
      enforcementDate, promulgationDate, currentRevisionId,
      parentLawDbId, relationType, xmlFileRef: null,
      sourceUrl: `https://laws.e-gov.go.jp/law/${lawId}`,
      articleCount: 0, isCore,
    });
    return dbId;
  }

  const { parsed, rawXml } = result;
  const { meta, articles } = parsed;

  // Drive 保存
  const xmlFileRef = await saveXmlToDrive(
    lawTitle, lawId,
    Buffer.from(rawXml, 'utf-8')
  );

  // regulations_law upsert
  const dbId = await upsertLaw({
    lawId,
    lawNum: meta.law_num || lawNum,
    title: meta.title || lawTitle,
    titleKana: meta.title_kana,
    abbrev: meta.abbrev,
    lawType: meta.law_type || lawType,
    categoryCds,
    enforcementDate: meta.enforcement_date || enforcementDate,
    promulgationDate: meta.promulgation_date || promulgationDate,
    currentRevisionId: meta.current_revision_id || currentRevisionId,
    repealStatus: meta.repeal_status,
    parentLawDbId,
    relationType,
    xmlFileRef,
    sourceUrl: `https://laws.e-gov.go.jp/law/${lawId}`,
    articleCount: articles.length,
    isCore,
  });

  // regulations_article 全削除 → 再投入
  await replaceArticles(dbId, articles);
  stats.articles += articles.length;

  // regulations_revision
  const revisions = await fetchRevisions(lawId);
  await upsertRevisions(dbId, revisions);
  stats.revisions += revisions.length;

  stats.laws++;
  console.log(`  ✓ ${lawTitle}: 条文 ${articles.length} 件 / 改正履歴 ${revisions.length} 件`);

  return dbId;
}

// ── --core モード ─────────────────────────────────────────────

async function runCore() {
  console.log('[sync] --core モード開始');
  console.log(`[sync] 対象法令数: ${CORE_LAWS.length} 件（施行令・施行規則含まず）`);
  console.log(`[sync] ${SOURCE_ATTRIBUTION}`);

  const targets = ONLY_FILTER ? CORE_LAWS.filter(e => e.title.includes(ONLY_FILTER)) : CORE_LAWS;
  if (ONLY_FILTER) console.log(`[sync] --only=${ONLY_FILTER} → ${targets.length} 件に絞り込み`);

  for (const entry of targets) {
    console.log(`\n[sync] ${entry.domain} / ${entry.title}`);

    try {
      // 本法の law_id を解決
      const mainInfo = await resolveLawId(entry.title, 'Act');
      if (!mainInfo) {
        console.warn(`  [skip] ${entry.title}: 法令未発見`);
        stats.skipped++;
        continue;
      }

      // 本法を先に投入（施行令の parent_law_id に必要）
      const mainDbId = await processOneLaw({
        ...mainInfo,
        categoryCds: entry.category || [],
        isCore: true,
        parentLawDbId: null,
        relationType: 'self',
      });

      // withEnforcement=true の場合、施行令・施行規則も取得
      if (entry.withEnforcement) {
        for (const sfx of ENFORCEMENT_SUFFIXES) {
          const enfTitle = `${entry.title}${sfx.suffix}`;
          const enfInfo = await resolveLawId(enfTitle, sfx.law_type);
          if (!enfInfo) {
            console.log(`  - ${enfTitle}: 見つからずスキップ`);
            continue;
          }

          const childDbId = await processOneLaw({
            ...enfInfo,
            categoryCds: entry.category || [],
            isCore: true,
            parentLawDbId: mainDbId,
            relationType: sfx.relation,
          });

          // 体系リンク（施行令→本法）
          await upsertEnforcementRef(childDbId, mainDbId, enfInfo.lawTitle);
        }
      }

    } catch (e) {
      console.error(`  [error] ${entry.title}: ${e.message}`);
      stats.errors++;
      // 1法令単位でエラーキャッチして継続
    }
  }
}

// ── --sweep モード（Phase 4 骨組み）─────────────────────────

async function runSweep() {
  console.log('[sync] --sweep モード開始（Phase 4 広域取得 - 骨組み）');
  console.log(`[sync] 対象カテゴリ: ${SWEEP_CATEGORIES.join(', ')}`);

  for (const categoryCd of SWEEP_CATEGORIES) {
    const label = CATEGORY_LABELS[categoryCd] || categoryCd;
    console.log(`\n[sync] カテゴリ ${categoryCd} (${label}) を取得中...`);

    for (const lawType of SWEEP_LAW_TYPES) {
      await sleep(EGOV_REQUEST_DELAY_MS);
      let data;
      try {
        data = await egov(
          `/laws?category_cd=${encodeURIComponent(categoryCd)}&law_type=${lawType}&response_format=json`
        );
      } catch (e) {
        console.warn(`  [warn] カテゴリ ${categoryCd}/${lawType} 取得失敗: ${e.message}`);
        continue;
      }

      const laws = data.laws || [];
      console.log(`  ${lawType}: ${laws.length} 件`);

      for (const entry of laws) {
        const lawInfo = entry.law_info || {};
        const revInfo = entry.revision_info || entry.current_revision_info || {};
        const lawId = lawInfo.law_id;
        const lawTitle = revInfo.law_title || '';

        if (!lawId || !lawTitle) continue;

        // CORE_LAWSに含まれる法令はスキップ（既に投入済み）
        const isAlreadyCore = CORE_LAWS.some(c => c.title === lawTitle);
        if (isAlreadyCore) {
          console.log(`  - スキップ（CORE済み）: ${lawTitle}`);
          continue;
        }

        try {
          await processOneLaw({
            lawId,
            lawTitle,
            lawNum: lawInfo.law_num || '',
            lawType: lawInfo.law_type || lawType,
            promulgationDate: lawInfo.promulgation_date || null,
            enforcementDate: revInfo.amendment_enforcement_date || null,
            currentRevisionId: revInfo.law_revision_id || null,
            categoryCds: [categoryCd],
            isCore: false,
            parentLawDbId: null,
            relationType: 'self',
          });
        } catch (e) {
          console.error(`  [error] ${lawTitle}: ${e.message}`);
          stats.errors++;
        }
      }
    }
  }
}

// ── メイン ────────────────────────────────────────────────────

async function main() {
  const startAt = Date.now();
  console.log(`[sync] 開始 ${new Date().toISOString()}`);

  // 環境変数チェック
  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
    console.error('[sync] SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です');
    process.exit(1);
  }

  try {
    if (MODE_CORE) await runCore();
    if (MODE_SWEEP) await runSweep();
  } catch (e) {
    console.error('[sync] 予期しないエラー:', e.message);
    stats.errors++;
  }

  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  console.log('\n[sync] ── 完了サマリ ───────────────────────────');
  console.log(`  法令数:     ${stats.laws} 件投入`);
  console.log(`  条文数:     ${stats.articles} 件投入`);
  console.log(`  改正履歴:   ${stats.revisions} 件投入`);
  console.log(`  スキップ:   ${stats.skipped} 件`);
  console.log(`  エラー:     ${stats.errors} 件`);
  console.log(`  所要時間:   ${elapsed} 秒`);
  console.log(`  出典: ${SOURCE_ATTRIBUTION}`);
  console.log('[sync] ──────────────────────────────────────────');

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[sync] 予期しないエラー:', e.message, e.stack);
  process.exit(1);
});
