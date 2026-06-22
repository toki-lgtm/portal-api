/**
 * classifyQuote.js
 * 見積比較機能 ── 6類型 自動分類エンジン
 *
 * 2軸の直積で見積ファイルを自動判定する。
 *   媒体軸 medium   : 'excel' | 'text_pdf' | 'image_pdf'  （読込アプローチ）
 *   書式軸 form_type: 'official' | 'vendor'                （照合アプローチ）
 *
 * class_no マッピング:
 *   1 = official × excel
 *   2 = vendor   × excel
 *   3 = official × text_pdf
 *   4 = official × image_pdf  ← 矛盾するが「将来 Vision OCR で official 判定できた場合」に備えて確保
 *   5 = vendor   × text_pdf
 *   6 = vendor   × image_pdf
 *
 * 重要: pdf-parse の index.js はモジュール読込時にデバッグ用テスト PDF を
 * 読みに行く副作用があり、本番でクラッシュし得る。
 * 必ず `pdf-parse/lib/pdf-parse.js` のサブパスを直接 import すること。
 * ここでは動的 import にして「PDF が来た時だけロード」にしている（さらに安全）。
 */

import * as XLSX from 'xlsx';

// ─────────────────────────────────────────────────────
// 1. class_no テーブル
// ─────────────────────────────────────────────────────

/** @type {Record<string, Record<string, number>>} */
const CLASS_NO_TABLE = {
  official: { excel: 1, text_pdf: 3, image_pdf: 4 },
  vendor:   { excel: 2, text_pdf: 5, image_pdf: 6 },
};

/**
 * form_type × medium → class_no (1..6)
 * @param {'official'|'vendor'} formType
 * @param {'excel'|'text_pdf'|'image_pdf'} medium
 * @returns {number}
 */
export function classNoOf(formType, medium) {
  return CLASS_NO_TABLE[formType]?.[medium] ?? 2; // 不明は vendor×excel 扱い
}

// ─────────────────────────────────────────────────────
// 2. ヘルパー
// ─────────────────────────────────────────────────────

/**
 * 文字列を NFKC 正規化 + 空白除去して返す（半角カナ対策）。
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s/g, '');
}

/**
 * 拡張子を小文字で返す（ドット込み, 例: '.xlsx'）。
 * @param {string} filename
 * @returns {string}
 */
function extOf(filename) {
  const m = String(filename ?? '').match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// ─────────────────────────────────────────────────────
// 3. 媒体軸判定
// ─────────────────────────────────────────────────────

/**
 * PDF バッファのテキスト層をプローブして medium を判定する。
 *
 * 築城の教訓 (コメントとして保存):
 *   テキスト層があっても CID で化ける社は実質 画像PDF（Vision 必須）。
 *   逆に一見化けて見えて実はクリーンな社もある。
 *   ヒューリスティックだけでは外すので必ず人が確認すること。
 *
 * @param {Buffer} buffer
 * @returns {Promise<{medium: 'text_pdf'|'image_pdf', confidence: 'high'|'low', signals: object}>}
 */
async function probePdfMedium(buffer) {
  // 動的 import: 本番クラッシュを防ぐためサブパス直指定
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');

  let text = '';
  let parseError = null;
  try {
    const data = await pdfParse(buffer);
    text = data.text ?? '';
  } catch (e) {
    parseError = e.message;
  }

  const charCount = text.length;

  // 数字比率（表形式なら高くなる）
  const digitCount = (text.match(/\d/g) ?? []).length;
  const digitRatio = charCount > 0 ? digitCount / charCount : 0;

  // 文字化け/CID 崩れ検知
  const cidCount     = (text.match(/\(cid:/g) ?? []).length;
  const replacementCount = (text.match(/�/g) ?? []).length;
  // 制御文字（改行/タブ以外の非表示文字）
  const controlCount = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) ?? []).length;
  // 日本語（かな/カナ/漢字）
  const jpCharCount  = (text.match(/[぀-ヿ一-鿿豈-﫿]/g) ?? []).length;
  // 非ASCII
  const nonAsciiCount = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  // 日本語が少ないのに非ASCII が多い = CID 文字化けの可能性
  const nonJpNonAsciiRatio = nonAsciiCount > 0
    ? (nonAsciiCount - jpCharCount) / nonAsciiCount
    : 0;

  const garbledRatio = charCount > 0
    ? (cidCount * 5 + replacementCount + controlCount) / charCount
    : 1; // テキストが無ければ garbled と見なす

  const signals = {
    charCount,
    digitRatio: +digitRatio.toFixed(3),
    cidCount,
    replacementCount,
    controlCount,
    garbledRatio: +garbledRatio.toFixed(3),
    jpCharCount,
    nonJpNonAsciiRatio: +nonJpNonAsciiRatio.toFixed(3),
    ...(parseError ? { parseError } : {}),
  };

  // 判定閾値
  const TEXT_THRESHOLD   = 200;   // クリーンな文字数がこれ以上あれば text_pdf 候補
  const GARBLED_MAX_HIGH = 0.05;  // garbledRatio がこれ未満 → high confidence
  const GARBLED_MAX_LOW  = 0.20;  // これ以上 → image_pdf と見なす

  if (parseError || charCount < 30) {
    // テキスト抽出失敗 or ほぼ文字なし → image_pdf
    return { medium: 'image_pdf', confidence: 'low', signals };
  }

  if (charCount >= TEXT_THRESHOLD && garbledRatio < GARBLED_MAX_HIGH) {
    return { medium: 'text_pdf', confidence: 'high', signals };
  }

  if (garbledRatio >= GARBLED_MAX_LOW || (cidCount > 10 && jpCharCount < 10)) {
    // CID だらけ、または日本語がほぼ無いのに化けている
    return { medium: 'image_pdf', confidence: 'low', signals };
  }

  // 境界付近 → 推定値を返しつつ low
  const medium = charCount >= TEXT_THRESHOLD ? 'text_pdf' : 'image_pdf';
  return { medium, confidence: 'low', signals };
}

// ─────────────────────────────────────────────────────
// 4. 書式軸判定 ── Excel
// ─────────────────────────────────────────────────────

/**
 * 公式数量書に現れるシート名のキーワード群（NFKC 正規化 + 空白除去後で照合）。
 */
const OFFICIAL_SHEET_KEYWORDS = ['種目', '科目', '細目別内訳', '別紙明細'];

/**
 * 公式数量書のヘッダキーワード（最低限揃っていれば official と判定）。
 */
const OFFICIAL_HEADER_KEYWORDS = ['名称', '数量', '単位', '単価', '金額'];

/**
 * Excel ブックから書式軸を判定する。
 * boqParser.js の detectCols は export されていないため、最小ヘッダ検出を自前実装。
 *
 * @param {Buffer} buffer
 * @returns {{ form_type: 'official'|'vendor', confidence: 'high'|'low', signals: object }}
 */
function classifyExcelFormType(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', sheetStubs: false });
  const sheetNames = wb.SheetNames.map(String);
  const normalizedSheetNames = sheetNames.map(normalize);

  // シート名に公式キーワードが含まれているか（NFKC 正規化後）
  const matchedSheetKeywords = OFFICIAL_SHEET_KEYWORDS.filter(kw =>
    normalizedSheetNames.some(s => s.includes(normalize(kw)))
  );
  const hasOfficialSheetName = matchedSheetKeywords.length >= 2; // 2種類以上一致で判定

  // 先頭の有効シートの先頭ヘッダ行を取得してキーワード照合
  let matchedHeaders = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    // シートの全セルから先頭 3 行分のテキストを収集
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
    const maxRow = Math.min(range.e.r, range.s.r + 4); // 先頭 5 行まで
    const texts = new Set();
    for (let r = range.s.r; r <= maxRow; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v != null) {
          texts.add(normalize(String(cell.v)));
        }
      }
    }
    matchedHeaders = OFFICIAL_HEADER_KEYWORDS.filter(kw =>
      [...texts].some(t => t.includes(normalize(kw)))
    );
    if (matchedHeaders.length >= 3) break; // 十分一致したら打ち切り
  }
  const hasOfficialHeader = matchedHeaders.length >= OFFICIAL_HEADER_KEYWORDS.length - 1;
  // 名称/数量/単位/単価/金額 のうち 4/5 以上一致

  const signals = {
    sheetNames,
    matchedSheetKeywords,
    matchedHeaders,
  };

  if (hasOfficialSheetName && hasOfficialHeader) {
    return { form_type: 'official', confidence: 'high', signals };
  }
  if (hasOfficialSheetName || hasOfficialHeader) {
    // 片方だけ一致 → 弱い判定
    return { form_type: hasOfficialSheetName ? 'official' : 'vendor', confidence: 'low', signals };
  }
  return { form_type: 'vendor', confidence: 'low', signals };
}

// ─────────────────────────────────────────────────────
// 5. 書式軸判定 ── text_pdf
// ─────────────────────────────────────────────────────

/**
 * 公式数量書の PDF ページ表題キーワード。
 */
const OFFICIAL_PDF_TITLES = ['細目別内訳', '科目別内訳', '種目別内訳', '別紙明細'];

/**
 * 公式数量書の列見出しキーワード。
 */
const OFFICIAL_PDF_HEADERS = ['名称', '摘要', '数量', '単位', '単価', '金額'];

/**
 * テキスト PDF から書式軸を判定する。
 *
 * @param {string} text  pdf-parse で抽出したテキスト全文
 * @returns {{ form_type: 'official'|'vendor', confidence: 'high'|'low', signals: object }}
 */
function classifyTextPdfFormType(text) {
  const normalized = normalize(text);

  const hasOfficialTitle = OFFICIAL_PDF_TITLES.some(t =>
    normalized.includes(normalize(t))
  );
  const matchedPdfHeaders = OFFICIAL_PDF_HEADERS.filter(h =>
    normalized.includes(normalize(h))
  );
  const hasOfficialHeader = matchedPdfHeaders.length >= OFFICIAL_PDF_HEADERS.length - 2;
  // 6キーワードのうち 4 以上一致

  const signals = {
    hasOfficialTitle,
    matchedPdfHeaders,
  };

  if (hasOfficialTitle && hasOfficialHeader) {
    return { form_type: 'official', confidence: 'high', signals };
  }
  if (hasOfficialTitle || hasOfficialHeader) {
    return { form_type: 'official', confidence: 'low', signals };
  }
  return { form_type: 'vendor', confidence: 'low', signals };
}

// ─────────────────────────────────────────────────────
// 6. メイン公開関数
// ─────────────────────────────────────────────────────

/**
 * 見積ファイルを自動判定して6類型を返す。
 *
 * 例外を絶対に投げない。どんな失敗でも拡張子ベースのフォールバックを返す。
 *
 * @param {{ buffer: Buffer, filename: string }} param
 * @returns {Promise<{
 *   medium: 'excel'|'text_pdf'|'image_pdf',
 *   form_type: 'official'|'vendor',
 *   class_no: number,
 *   confidence: 'high'|'low',
 *   signals: object
 * }>}
 */
export async function classifyQuote({ buffer, filename }) {
  const ext = extOf(filename);
  const baseSignals = { ext };

  try {
    // ── 媒体軸判定 ──
    if (ext === '.xlsx' || ext === '.xlsm') {
      // Excel: 媒体は確定 high、書式軸判定へ
      const { form_type, confidence, signals } = classifyExcelFormType(buffer);
      const medium = 'excel';
      return {
        medium,
        form_type,
        class_no: classNoOf(form_type, medium),
        confidence,
        signals: { ...baseSignals, ...signals },
      };
    }

    if (ext === '.pdf') {
      // PDF: テキスト層プローブで medium 判定
      const {
        medium,
        confidence: mediumConf,
        signals: pdfSignals,
      } = await probePdfMedium(buffer);

      if (medium === 'text_pdf') {
        // テキスト抽出済みなので書式軸も判定
        const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
        let text = '';
        try { text = (await pdfParse(buffer)).text ?? ''; } catch (_) {}
        const {
          form_type,
          confidence: formConf,
          signals: formSignals,
        } = classifyTextPdfFormType(text);

        // 媒体 high かつ 書式 high の場合のみ全体 high
        const confidence = mediumConf === 'high' && formConf === 'high' ? 'high' : 'low';
        return {
          medium,
          form_type,
          class_no: classNoOf(form_type, medium),
          confidence,
          signals: { ...baseSignals, ...pdfSignals, ...formSignals },
        };
      }

      // image_pdf: 書式はテキストから判定不能 → vendor/low
      return {
        medium: 'image_pdf',
        form_type: 'vendor',
        class_no: classNoOf('vendor', 'image_pdf'),
        confidence: 'low',
        signals: { ...baseSignals, ...pdfSignals },
      };
    }

    // ── 不明拡張子 ──
    return {
      medium: 'image_pdf', // 最善推定（PDF 系として扱う）
      form_type: 'vendor',
      class_no: classNoOf('vendor', 'image_pdf'),
      confidence: 'low',
      signals: { ...baseSignals, unknown_ext: true },
    };

  } catch (err) {
    // フォールバック: 拡張子ベースの最善推定
    const medium = (ext === '.xlsx' || ext === '.xlsm')
      ? 'excel'
      : 'image_pdf';
    return {
      medium,
      form_type: 'vendor',
      class_no: classNoOf('vendor', medium),
      confidence: 'low',
      signals: { ...baseSignals, error: err?.message ?? String(err) },
    };
  }
}
