// 数量書（内訳書 .xlsx）解析
//
// 入札の積算 xlsx から「総額1つ」だけを拾う bidEstimate.js とは別に、
// こちらは内訳書の明細を全行読み、工事内容（名称）・数量・単位・単価・金額を
// 構造化し、工種別に集計して構成比率を返す。案件ごとに書式が違うため固定セルでは
// なくヘッダ行をキーワードで検出し、列位置を動的に決める。
//
// 工種(trade) は required_doc_templates.trade の語彙へ正規化する。これにより
// 「数量書に出現した工種」と「工種別の施工計画書」を突合し、不要書類のNA化に使える。
import * as XLSX from 'xlsx';

// ── 正規化工種の語彙（required_doc_templates.trade と一致させる）──
export const CANONICAL_TRADES = [
  '仮設', '土工事', '地業', '鉄筋', 'コンクリート', '鉄骨', 'CB/ALC', '防水',
  '石', 'タイル', '木', '屋根樋', '金属', '左官', '建具', '塗装', '内装',
  'ユニット', '解体', '電気', '機械', '安全',
];

// 工種名キーワード → 正規化工種（上から順に判定。より特異なものを先に置く）
const TRADE_RULES = [
  [/解体|撤去|発生材|アスベスト|石綿/, '解体'],
  [/鉄筋|ガス圧接/, '鉄筋'],
  [/鉄骨/, '鉄骨'],
  [/ブロック|ＡＬＣ|ALC|ＣＢ|押出成形|軽量気泡/, 'CB/ALC'],
  [/型枠|コンクリート|ｺﾝｸﾘｰﾄ|生コン|既製コン/, 'コンクリート'],
  [/防水|シーリング|シール材/, '防水'],
  [/タイル/, 'タイル'],
  [/石工事|石張|石材|擬石/, '石'],
  [/屋根|とい|樋|ルーフィング|折板/, '屋根樋'],
  [/金属工事|金物|笠木|手摺|ﾒﾀﾙ/, '金属'],
  [/左官|モルタル塗|吹付|仕上塗材|セルフレベリング/, '左官'],
  [/建具|硝子|ガラス|サッシ|ｻｯｼ|シャッター|ｼｬｯﾀｰ|自動扉/, '建具'],
  [/塗装|塗替/, '塗装'],
  [/内装|床仕上|壁仕上|天井|ボード|クロス|畳|カーペット|フローリング|間仕切/, '内装'],
  [/ユニット|家具|流し|厨房|洗面化粧|可動間仕切|サイン/, 'ユニット'],
  [/木工事|木製|造作/, '木'],
  [/地業|杭|山留|地盤改良|砕石|捨てコン/, '地業'],
  [/土工事|根切|土工|掘削|埋戻|残土/, '土工事'],
  [/仮設/, '仮設'],
  [/電気設備|電気工事|弱電|受変電|照明|動力/, '電気'],
  [/機械設備|給排水|衛生|空調|換気|ガス設備|消火|昇降機|エレベータ|ｴﾚﾍﾞｰﾀ/, '機械'],
  [/安全衛生|安全管理/, '安全'],
];

// 集計から除外する小計・経費・税の行（金額があっても明細として数えない）
const SUBTOTAL_RE = /(小計|合計|計上|総計|総額|直接工事費|純工事費|工事原価|工事価格|工事費計|諸経費|現場管理費|一般管理費|共通費|消費税|内訳|値引|端数|per)/i;

export function normalizeTrade(name) {
  const s = (name == null ? '' : String(name)).replace(/\s/g, '');
  if (!s) return null;
  for (const [re, trade] of TRADE_RULES) if (re.test(s)) return trade;
  return null;
}

export function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[,，\s¥￥円]/g, '').replace(/[^0-9.\-]/g, '');
  if (!digits || digits === '-' || digits === '.') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function toText(v) {
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

// 行を {名称, 規格, 数量, 単位, 単価, 金額} の配列に。ヘッダのキーワードで列を特定。
const HEADER_KEYS = {
  name:   ['名称', '摘要', '工種', '種別', '品名', '細目', '名 称', '工事区分', '区分'],
  spec:   ['規格', '仕様', '形状', '寸法'],
  qty:    ['数量', '数 量'],
  unit:   ['単位'],
  price:  ['単価', '単金', '代価'],
  amount: ['金額', '価格', '金 額'],
};

function detectColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const row = rows[r] || [];
    const cols = {};
    for (let c = 0; c < row.length; c++) {
      const t = toText(row[c]).replace(/\s/g, '');
      if (!t) continue;
      for (const key of Object.keys(HEADER_KEYS)) {
        if (cols[key] != null) continue;
        if (HEADER_KEYS[key].some((k) => t.includes(k.replace(/\s/g, '')))) { cols[key] = c; break; }
      }
    }
    // 金額列＋（名称 or 数量）があればヘッダ行とみなす
    if (cols.amount != null && (cols.name != null || cols.qty != null)) {
      return { headerRow: r, cols };
    }
  }
  return null;
}

// 1シートを解析して明細配列を返す
function parseSheet(ws, sheetName) {
  if (!ws || !ws['!ref']) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const det = detectColumns(rows);
  if (!det) return [];
  const { headerRow, cols } = det;
  const out = [];
  let currentTrade = null;
  let currentRaw = null;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = cols.name != null ? toText(row[cols.name]) : '';
    const spec = cols.spec != null ? toText(row[cols.spec]) : '';
    const qty = cols.qty != null ? toNumber(row[cols.qty]) : null;
    const unit = cols.unit != null ? toText(row[cols.unit]) : '';
    const price = cols.price != null ? toNumber(row[cols.price]) : null;
    const amount = cols.amount != null ? toNumber(row[cols.amount]) : null;

    if (!name && amount == null && qty == null) continue; // 空行

    const isSubtotal = SUBTOTAL_RE.test(name.replace(/\s/g, ''));
    const ownTrade = normalizeTrade(name);

    // 工種見出し行: 名称が工種に一致し、数量が無い（科目見出し）→ セクションを切替
    const looksHeader = ownTrade && qty == null;
    if (looksHeader) {
      currentTrade = ownTrade;
      currentRaw = name;
      // 見出し自身が金額を持つ（種目別内訳）場合も section 候補として記録
      out.push({ level: 0, trade: ownTrade, raw_category: name, item_name: name, spec: '',
                 quantity: null, unit: '', unit_price: null, amount, sort_order: r });
      continue;
    }

    if (isSubtotal) continue;            // 小計・経費・税は集計対象外
    if (amount == null) continue;        // 金額の無い行は明細として扱わない

    out.push({
      level: 1,
      trade: ownTrade || currentTrade || null,
      raw_category: currentRaw || (ownTrade ? name : null),
      item_name: name || '(名称なし)',
      spec: spec || null,
      quantity: qty,
      unit: unit || null,
      unit_price: price,
      amount: Math.round(amount),
      sort_order: r,
    });
  }
  return out;
}

// 工事全体の数量書を解析。複数シートを走査し、明細とサマリ（工種別構成比率）を返す。
export function parseBoqFromXlsx(buffer, sourceFile) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let all = [];
  for (const name of wb.SheetNames) {
    const items = parseSheet(wb.Sheets[name], name).map((it) => ({ ...it, sheet_name: name, source_file: sourceFile || null }));
    all = all.concat(items);
  }

  const details = all.filter((x) => x.level === 1);
  const headerRows = all.filter((x) => x.level === 0 && x.amount != null);
  const detailTotal = details.reduce((s, x) => s + (x.amount || 0), 0);

  // 明細が拾えていれば明細ベース。皆無なら種目別見出し（科目）の金額ベースへフォールバック。
  let rows, mode;
  if (detailTotal > 0) {
    rows = details;
    mode = 'detail';
  } else if (headerRows.length) {
    rows = headerRows.map((x) => ({ ...x, level: 1 }));
    mode = 'section';
  } else {
    rows = [];
    mode = 'empty';
  }

  // 工種別集計（trade が null の明細は raw_category もしくは「その他」でまとめる）
  const byKey = new Map();
  for (const x of rows) {
    const key = x.trade || x.raw_category || 'その他';
    const cur = byKey.get(key) || { trade: key, canonical: !!x.trade, amount: 0, item_count: 0 };
    cur.amount += x.amount || 0;
    cur.item_count += 1;
    if (x.trade) cur.canonical = true;
    byKey.set(key, cur);
  }
  const total = rows.reduce((s, x) => s + (x.amount || 0), 0);
  const summary = Array.from(byKey.values())
    .map((t) => ({ ...t, ratio: total > 0 ? t.amount / total : null }))
    .sort((a, b) => b.amount - a.amount);

  // 出現した正規化工種の集合（チェックリスト絞り込み用）
  const presentTrades = Array.from(new Set(rows.map((x) => x.trade).filter(Boolean)));

  return { rows, summary, total, mode, presentTrades, lineCount: rows.length };
}
