// ============================================================
// 法令XML パーサ
//
// e-Gov法令API v2 が返す標準法令XML文字列を受け取り、
// 030_regulations.sql スキーマに対応した中間オブジェクトを返す純関数群。
//
// 実データ検証（2026-06-16）で確認した構造:
//   - /law_data レスポンスはJSONラッパー付き。法令本文XMLは
//     law_full_text フィールドにBase64エンコードで格納される。
//   - 要素階層: Law > LawBody > MainProvision > Chapter > Article
//   - Articleの直下: ArticleCaption（見出し）、Paragraph
//     ※ ArticleTitleはTOC内に現れる場合があるがArticle直下はArticleCaptionが主体
//   - 枝番条文の Num 属性: "17_2" 形式（アラビア数字＋アンダースコア）
//   - ParagraphNum は空要素 <ParagraphNum/> として存在する
//   - ItemTitle に "第一号" 等の号記号が入る
//   - 附則: SupplProvision 要素、別表: AppdxTable / AppdxStyle 要素
//
// 依存: fast-xml-parser（npm install fast-xml-parser）
// ============================================================

import { XMLParser } from 'fast-xml-parser';

// XMLパーサの共通オプション
// ignoreAttributes=false にして Num 等の属性を取得する
//
// 実データ検証（建設業法 324AC0000000100）で確認した構造:
//   - SupplProvision は Law > LawBody 内（Law直下ではない）
//   - AppdxTable も LawBody 直下
//   - 附則は Paragraph（古い附則）と Article（新しい改正附則）の両方がありうる
//   - @_AmendLawNum 属性で改正附則を識別可能
const XML_PARSER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false, // 属性値は文字列のまま
  trimValues: true,
  isArray: (tagName) => {
    // 複数出現しうる要素は常に配列として受け取る
    return [
      'Chapter', 'Section', 'Subsection', 'Division',
      'Article', 'Paragraph', 'Item', 'Subitem1', 'Subitem2',
      'Sentence', 'Column',
      'SupplProvision', 'AppdxTable', 'AppdxStyle', 'Appdx',
      'TOCChapter', 'TOCSection', 'TOCArticle',
      'Part',
    ].includes(tagName);
  },
};

// ── テキスト抽出ユーティリティ ────────────────────────────────

/**
 * fast-xml-parser がパースしたノードから再帰的にテキストを抽出する。
 * 入れ子要素の文字列を全て連結して返す。
 */
function extractText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object') {
    // #text キーが直接テキストを持つ場合
    const parts = [];
    for (const [key, val] of Object.entries(node)) {
      if (key === '@_Num' || key === '@_WritingMode' || key === '@_Type'
          || key.startsWith('@_')) continue; // 属性はスキップ
      parts.push(extractText(val));
    }
    return parts.join('');
  }
  return '';
}

/**
 * ParagraphSentence, ItemSentence 等の中身を読みやすい日本語テキストに変換する。
 * Sentence 要素を単純連結（改行は入れない）。
 */
function sentenceText(sentenceNode) {
  if (!sentenceNode) return '';
  if (Array.isArray(sentenceNode)) {
    return sentenceNode.map(sentenceText).join('');
  }
  // Sentence 要素が配列の場合は連結
  const sentences = sentenceNode.Sentence;
  if (sentences) {
    const arr = Array.isArray(sentences) ? sentences : [sentences];
    return arr.map(s => extractText(s)).join('');
  }
  return extractText(sentenceNode);
}

/**
 * 号(Item)の階層を整形してテキスト化する。
 * ItemTitle（"一"/"イ"等）と ItemSentence を組み合わせる。
 * 再帰的に Subitem1, Subitem2 も処理する。
 */
function formatItem(item, depth = 0) {
  if (!item) return '';
  const indent = '　'.repeat(depth + 1);
  const title = extractText(item.ItemTitle || '');
  const body = sentenceText(item.ItemSentence);
  let text = `${indent}${title}　${body}`;

  // サブ項目（細分項目）の処理
  const sub1 = item.Subitem1;
  if (sub1) {
    const arr = Array.isArray(sub1) ? sub1 : [sub1];
    text += '\n' + arr.map(s => {
      const t = extractText(s.Subitem1Title || '');
      const b = sentenceText(s.Subitem1Sentence);
      return `${'　'.repeat(depth + 2)}${t}　${b}`;
    }).join('\n');
  }
  return text;
}

/**
 * Paragraph を整形して文字列化する。
 * 「第N項」の項番号＋本文＋号リストを組み立てる。
 */
function formatParagraph(para, paraIndex) {
  if (!para) return '';
  const num = para['@_Num'] || String(paraIndex + 1);

  // 項の本文（ParagraphSentence）
  const body = sentenceText(para.ParagraphSentence);

  // 項番号は複数項あるときのみ付与（第1項のみの条文では付けない）
  const numLabel = num === '1' ? '' : `（第${num}項）　`;
  let text = `${numLabel}${body}`;

  // 号(Item)の処理
  const items = para.Item;
  if (items) {
    const arr = Array.isArray(items) ? items : [items];
    const itemTexts = arr.map(item => formatItem(item, 0));
    text += '\n' + itemTexts.join('\n');
  }
  return text;
}

/**
 * Article ノードを regulations_article 1行分のオブジェクトに変換する。
 * @param {object} article - fast-xml-parserのArticleノード
 * @param {object} ctx - { partNum, partTitle, chapterNum, chapterTitle,
 *                         sectionNum, sectionTitle, subsectionNum, subsectionTitle,
 *                         division, supplLabel }
 * @param {number} sortOrder - 法令内通し番号
 * @returns {object} regulations_articleに対応するオブジェクト
 */
function parseArticle(article, ctx, sortOrder) {
  // Num 属性: "3", "17_2" 等
  const numRaw = article['@_Num'] || '';

  // ArticleCaption が条見出し（括弧付き。例: "（建設業の許可）"）
  const caption = extractText(article.ArticleCaption || '');

  // 条文本文: Paragraph を収集して整形
  const paragraphs = article.Paragraph;
  let content = '';
  if (paragraphs) {
    const arr = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
    const parts = arr.map((p, i) => formatParagraph(p, i)).filter(Boolean);
    content = parts.join('\n');
  }

  // 参照表現の簡易抽出（「○○法」「第○条」パターン）
  const refs = extractLawRefs(content);

  return {
    division: ctx.division || 'main',
    suppl_label: ctx.supplLabel || null,
    part_num: ctx.partNum || null,
    part_title: ctx.partTitle || null,
    chapter_num: ctx.chapterNum || null,
    chapter_title: ctx.chapterTitle || null,
    section_num: ctx.sectionNum || null,
    section_title: ctx.sectionTitle || null,
    subsection_num: ctx.subsectionNum || null,
    subsection_title: ctx.subsectionTitle || null,
    article_num: numRaw,
    article_caption: caption || null,
    content: content || '（条文なし）',
    sort_order: sortOrder,
    _refs: refs, // 内部的に参照情報を持ち、sync.js で regulations_reference に投入
  };
}

/**
 * 条文本文から参照表現を簡易抽出する。
 * 「○○法」「○○令」「○○規則」のパターン。
 * 区切り文字（句点・読点・括弧・空白）で前後が囲まれているものを収録し、
 * 文脈途中に埋め込まれた断片（「○○に係る法」等）は除外する。
 * 過剰実装しない（Phase 2 以降で精度向上）。
 */
function extractLawRefs(text) {
  if (!text) return [];

  // 「『法令名』」の正規表現:
  //   - 先頭区切り文字（行頭, 、。「」（）、空白等）の後に出現
  //   - 漢字・ひらがな・カタカナで2〜16文字
  //   - 「法律」「施行令」「施行規則」「規則」「法」で終わる
  //   - 直後に任意の空白 + 「第○条」の参照
  // 具体的な固有法令名を持つもののみ: 「学校教育法」「行政手続法」「刑法」等
  const LAW_SUFFIX = '(?:法律|施行令|施行規則|施行細則|規則|法)';
  const KANJI_RANGE = '[一-鿿ぁ-んァ-ヾ]';
  const LAW_NAME = `(${KANJI_RANGE}{2,16}${LAW_SUFFIX})`;
  const ARTICLE_REF = `\\s*(?:第([一二三四五六七八九十百千\d]+)条)?`;

  // 区切り文字（前後いずれかがあること）で固有名詞を確認
  const pattern = new RegExp(
    `(?<=[、。（「 　・\\n]|^)${LAW_NAME}${ARTICLE_REF}(?=[、。）」 　第\\n]|$)`,
    'gmu'
  );

  // 年号ベースのキャプチャ（「昭和二十二年法律」等）と自己参照をスキップ
  const SKIP_TITLE = /^(?:この|同|当該|旧|新|改正前の|改正後の|移行期間|第\d)[^\n]{0,10}(?:法律|法令|法)$/;
  const YEAR_ONLY = /^(?:明治|大正|昭和|平成|令和)[^\n]{1,6}(?:年法律|年法令)$/;

  const seen = new Set();
  const refs = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const lawTitle = m[1];
    const articleNum = m[2] || null;
    const key = `${lawTitle}:${articleNum}`;
    if (seen.has(key)) continue;
    // 自己参照・年号のみの断片・短すぎる名前をスキップ
    if (SKIP_TITLE.test(lawTitle) || YEAR_ONLY.test(lawTitle)) continue;
    if (lawTitle.length < 3) continue;
    seen.add(key);
    refs.push({
      to_law_title: lawTitle,
      to_article_num: articleNum,
      ref_text: m[0].trim(),
      ref_type: 'citation',
    });
  }
  return refs;
}

// ── 階層走査 ──────────────────────────────────────────────────

/**
 * Section/Subsection 内の Article を再帰的に収集する。
 */
function collectFromSection(sectionNode, ctx, articles, counter) {
  const subCtx = {
    ...ctx,
    sectionNum: sectionNode['@_Num'] || null,
    sectionTitle: extractText(sectionNode.SectionTitle || ''),
  };

  // 款(Subsection)
  const subsections = sectionNode.Subsection;
  if (subsections) {
    const arr = Array.isArray(subsections) ? subsections : [subsections];
    for (const sub of arr) {
      const subCtx2 = {
        ...subCtx,
        subsectionNum: sub['@_Num'] || null,
        subsectionTitle: extractText(sub.SubsectionTitle || ''),
      };
      collectArticles(sub, subCtx2, articles, counter);
    }
  }

  // セクション直下の条
  collectArticles(sectionNode, subCtx, articles, counter);
}

/**
 * 任意のノードから Article を収集して articles 配列に追加する。
 * @param {object} node - Chapter, Section, Subsection, SupplProvision 等
 * @param {object} ctx - 現在の階層コンテキスト
 * @param {object[]} articles - 結果配列（mutable）
 * @param {{ val: number }} counter - sortOrder カウンタ（参照渡し）
 */
function collectArticles(node, ctx, articles, counter) {
  const rawArticles = node.Article;
  if (rawArticles) {
    const arr = Array.isArray(rawArticles) ? rawArticles : [rawArticles];
    for (const a of arr) {
      articles.push(parseArticle(a, ctx, counter.val++));
    }
  }
}

/**
 * Chapter を走査してその配下の Section / Article を収集する。
 */
function collectFromChapter(chapter, ctx, articles, counter) {
  const chapCtx = {
    ...ctx,
    chapterNum: chapter['@_Num'] || null,
    chapterTitle: extractText(chapter.ChapterTitle || ''),
  };

  // Section（節）
  const sections = chapter.Section;
  if (sections) {
    const arr = Array.isArray(sections) ? sections : [sections];
    for (const sec of arr) {
      collectFromSection(sec, chapCtx, articles, counter);
    }
  }

  // Chapter 直下の Article（節に属さないもの）
  collectArticles(chapter, chapCtx, articles, counter);
}

/**
 * Part（編）を走査して Chapter / Article を収集する。
 */
function collectFromPart(part, ctx, articles, counter) {
  const partCtx = {
    ...ctx,
    partNum: part['@_Num'] || null,
    partTitle: extractText(part.PartTitle || ''),
  };

  const chapters = part.Chapter;
  if (chapters) {
    const arr = Array.isArray(chapters) ? chapters : [chapters];
    for (const ch of arr) {
      collectFromChapter(ch, partCtx, articles, counter);
    }
  }
  collectArticles(part, partCtx, articles, counter);
}

/**
 * 附則(SupplProvision)を走査して条文を収集する。
 *
 * 実データ検証で確認した構造:
 *   - 附則の本文は Article（新しい改正附則）または Paragraph（古い附則）の両方がありうる
 *   - @_AmendLawNum 属性で改正附則のラベルを補完できる
 *   - SupplProvision は LawBody 直下に配列で複数存在する（56件など）
 */
function collectFromSupplProvision(supplNode, articles, counter) {
  // 附則ラベル（「附　則」「附　則　（昭和二六年…）」等）
  const labelText = extractText(supplNode.SupplProvisionLabel || '').trim() || '附則';
  const amendNum = supplNode['@_AmendLawNum'] || '';
  const label = amendNum ? `${labelText}（${amendNum}）` : labelText;

  const ctx = {
    division: 'suppl',
    supplLabel: label,
    partNum: null, partTitle: null,
    chapterNum: null, chapterTitle: null,
    sectionNum: null, sectionTitle: null,
    subsectionNum: null, subsectionTitle: null,
  };

  // 附則内の Article（新しい改正附則：条が立てられている）
  collectArticles(supplNode, ctx, articles, counter);

  // 附則内の Chapter（章構成の附則）
  const chapters = supplNode.Chapter;
  if (chapters) {
    const arr = Array.isArray(chapters) ? chapters : [chapters];
    for (const ch of arr) {
      collectFromChapter(ch, ctx, articles, counter);
    }
  }

  // 附則内の Paragraph（古い附則：条番号なく段落のみ）
  // Article がない場合のみ Paragraph を1行として収録する
  const hasArticles = Boolean(supplNode.Article)
    || Boolean(supplNode.Chapter);
  if (!hasArticles) {
    const paragraphs = supplNode.Paragraph;
    if (paragraphs) {
      const arr = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
      const parts = arr.map((p, i) => formatParagraph(p, i)).filter(Boolean);
      if (parts.length > 0) {
        // 段落群をまとめて1行にする（附則全体で1行）
        const paraCaption = extractText(arr[0]?.ParagraphCaption || '');
        articles.push({
          ...ctx,
          article_num: null,
          article_caption: paraCaption || null,
          content: parts.join('\n'),
          sort_order: counter.val++,
          _refs: extractLawRefs(parts.join('\n')),
        });
      }
    }
  }
}

/**
 * 別表(AppdxTable/AppdxStyle/Appdx)を要約して appendix 行として収集する。
 * 巨大な画像は含めず、別表名と本文テキストのみ保持する。
 */
function collectFromAppdx(appdxNode, tagName, articles, counter) {
  // 別表タイトル
  const titleKey = tagName === 'AppdxTable' ? 'AppdxTableTitle'
    : tagName === 'AppdxStyle' ? 'AppdxStyleTitle'
    : 'AppdxTitle';
  const title = extractText(appdxNode[titleKey] || appdxNode.AppdxTableTitle || '');

  // テキスト部分のみ抽出（TableStructure等は除く）
  const relatedArticleText = extractText(appdxNode.RelatedArticleNum || '');
  const textContent = extractText(appdxNode.Remarks || appdxNode.Item || '');

  const content = [
    title ? `【${title}】` : '【別表】',
    relatedArticleText ? `関係条文: ${relatedArticleText}` : '',
    textContent || '（別表本体はGoogle Driveの原本XMLを参照）',
  ].filter(Boolean).join('\n');

  const ctx = {
    division: 'appendix',
    supplLabel: null,
    partNum: null, partTitle: null,
    chapterNum: null, chapterTitle: null,
    sectionNum: null, sectionTitle: null,
    subsectionNum: null, subsectionTitle: null,
  };

  articles.push({
    ...ctx,
    article_num: null,
    article_caption: title || '別表',
    content,
    sort_order: counter.val++,
    _refs: [],
  });
}

// ── メインのパーサ関数 ────────────────────────────────────────

/**
 * e-Gov法令API v2 の /law_data レスポンスJSON文字列（またはオブジェクト）を受け取り、
 * Base64デコード → XML解析 → 中間オブジェクトを返す。
 *
 * @param {string|object} responseJsonOrObj - /law_data レスポンス（JSON文字列 or パース済みオブジェクト）
 * @returns {{ meta: object, articles: object[], revisions: object[] }}
 *   - meta: regulations_law に対応するメタ情報
 *   - articles: regulations_article に対応する配列（_refs フィールドを含む）
 *   - revisions: [] （law_revisions API から別途取得するため空）
 */
export function parseLawResponse(responseJsonOrObj) {
  const resp = typeof responseJsonOrObj === 'string'
    ? JSON.parse(responseJsonOrObj)
    : responseJsonOrObj;

  // Base64デコード
  const xmlString = Buffer.from(resp.law_full_text, 'base64').toString('utf-8');

  return parseLawXml(xmlString, resp);
}

/**
 * e-Gov法令標準XML文字列を受け取り、中間オブジェクトを返す純関数。
 *
 * @param {string} xmlString - 法令XML文字列
 * @param {object} [apiMeta] - /law_data レスポンスの law_info / revision_info（省略可）
 * @returns {{ meta: object, articles: object[], revisions: object[] }}
 */
export function parseLawXml(xmlString, apiMeta = {}) {
  const parser = new XMLParser(XML_PARSER_OPTS);
  const doc = parser.parse(xmlString);

  const law = doc.Law || {};
  const lawBody = law.LawBody || {};

  // ── メタ情報の構築 ──
  const lawInfo = apiMeta.law_info || {};
  const revisionInfo = apiMeta.revision_info || apiMeta.current_revision_info || {};

  const meta = {
    law_id: lawInfo.law_id || law['@_LawId'] || '',
    law_num: lawInfo.law_num || extractText(law.LawNum || ''),
    title: extractText(lawBody.LawTitle || revisionInfo.law_title || ''),
    title_kana: lawBody.LawTitle?.['@_Kana'] || null,
    abbrev: lawBody.LawTitle?.['@_Abbrev'] || null,
    law_type: lawInfo.law_type || law['@_LawType'] || null,
    promulgation_date: lawInfo.promulgation_date || null,
    enforcement_date: revisionInfo.amendment_enforcement_date || null,
    current_revision_id: revisionInfo.law_revision_id || null,
    repeal_status: revisionInfo.repeal_status || null,
  };

  // ── 条文の収集 ──
  const articles = [];
  const counter = { val: 0 };
  const baseCtx = {
    division: 'main',
    supplLabel: null,
    partNum: null, partTitle: null,
    chapterNum: null, chapterTitle: null,
    sectionNum: null, sectionTitle: null,
    subsectionNum: null, subsectionTitle: null,
  };

  const mainProvision = lawBody.MainProvision || {};

  // Part（編）がある場合
  const parts = mainProvision.Part;
  if (parts) {
    const arr = Array.isArray(parts) ? parts : [parts];
    for (const part of arr) {
      collectFromPart(part, baseCtx, articles, counter);
    }
  }

  // Chapter（章）が直接ある場合
  const chapters = mainProvision.Chapter;
  if (chapters) {
    const arr = Array.isArray(chapters) ? chapters : [chapters];
    for (const ch of arr) {
      collectFromChapter(ch, baseCtx, articles, counter);
    }
  }

  // MainProvision 直下の Article（章にも属さないもの）
  collectArticles(mainProvision, baseCtx, articles, counter);

  // 附則(SupplProvision)
  // 実データ検証済み: SupplProvision は LawBody 直下（Law 直下ではない）
  const suppls = lawBody.SupplProvision || law.SupplProvision;
  if (suppls) {
    const arr = Array.isArray(suppls) ? suppls : [suppls];
    for (const s of arr) {
      collectFromSupplProvision(s, articles, counter);
    }
  }

  // 別表(AppdxTable / AppdxStyle / Appdx)
  // 実データ検証済み: AppdxTable は LawBody 直下
  for (const tagName of ['AppdxTable', 'AppdxStyle', 'Appdx']) {
    const appdxNodes = lawBody[tagName] || law[tagName];
    if (appdxNodes) {
      const arr = Array.isArray(appdxNodes) ? appdxNodes : [appdxNodes];
      for (const a of arr) {
        collectFromAppdx(a, tagName, articles, counter);
      }
    }
  }

  return {
    meta,
    articles,
    revisions: [], // law_revisions API から sync.js で別途取得
  };
}
