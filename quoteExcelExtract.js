// quoteExcelExtract.js
// 見積比較機能 ── Excel 見積の直読抽出（クラウド Node 完結・即時／ローカルエージェント不要）
//
// 対象は 6 類型のうち Excel 2 種:
//   類型1 = official × excel : 発注者数量書テンプレに各社が単価を記入した Excel。
//           原本と同一様式なので (sheet, excel_row) の位置で単価列を直読する（照合不要）。
//           行ずれ（テンプレ改変・行挿入）は数量サニティチェックで検出し要レビュー化。
//   類型2 = vendor   × excel : 各社独自様式の Excel。ヘッダ列を自動検出して明細を取り出し、
//           BOQ 索引へ Pass1(数量+単位 完全一致)/Pass2(名称ファジー) で照合する。
//           照合ロジックは築城 lib_quote.match のJS移植（difflib 比率も移植）。
//
// 返却は P2 ローカルエージェントの result.json と同じ契約:
//   { cells:[{boq_row_id, unit_price, match_type:'qty'|'name'|'pos_review', sim, source_label}],
//     unmatched:[{name, spec, quantity, unit, unit_price, best_candidate, sim}],
//     excluded:[{label, amount, reason}], extracted_total, checksum }
// → server.js の importQuoteResult が DB(quote_cells/quote_unmatched) へ取り込む。

import * as XLSX from 'xlsx';
import { toText, sheetRows } from './boqParser.js';

// ── 数値/単位/文字列 正規化（築城 lib_quote.num/unorm/clean の移植）──

// カンマ・▲・△ を除いて数値化（▲△ はマイナス記号）。失敗は null。
function qnum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/[▲△]/g, '-').replace(/[¥￥円\s]/g, '').trim();
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const UNIT_MAP = {
  m2: '㎡', m: 'ｍ', M: 'ｍ', メートル: 'ｍ', ｍｅｔｅｒ: 'ｍ', m3: 'm3', '㎥': 'm3', ｍ3: 'm3', M3: 'm3', M2: '㎡',
  平米: '㎡', 平方メートル: '㎡',
  箇所: 'か所', ヶ所: 'か所', ｹ所: 'か所', カ所: 'か所', ケ所: 'か所', ヵ所: 'か所', ヶ: 'か所', 力所: 'か所', ヶ箇所: 'か所',
};
function unorm(u) {
  if (!u) return '';
  const s = String(u).normalize('NFKC').trim();
  return UNIT_MAP[s] || s;
}
function clean(s) {
  return String(s ?? '').normalize('NFKC').replace(/_x000D_/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── difflib.SequenceMatcher.ratio() の移植（Ratcliff/Obershelp, autojunk無し）──
function matchingBlocksSum(a, b) {
  const helper = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = {};
    for (let i = alo; i < ahi; i++) {
      const newj2len = {};
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const k = (j2len[j - 1] || 0) + 1;
          newj2len[j] = k;
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
      }
      j2len = newj2len;
    }
    if (bestsize === 0) return 0;
    return bestsize
      + helper(alo, besti, blo, bestj)
      + helper(besti + bestsize, ahi, bestj + bestsize, bhi);
  };
  return helper(0, a.length, 0, b.length);
}
function seqRatio(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  const T = sa.length + sb.length;
  if (T === 0) return 1;
  return (2 * matchingBlocksSum(sa, sb)) / T;
}

// ── 行種別の判定 ──
const SUBTOTAL_RE = /^(小計|合計|計|総計|総額|内訳|直接工事費|工事価格|請負金額|見積金額)$/;
function isSubtotalName(name) {
  return SUBTOTAL_RE.test(String(name || '').replace(/\s/g, ''));
}
// 経費・値引・調整など、BOQ細目に対応しない自社項目（除外して別掲）
const OVERHEAD_RE = /(諸経費|一般管理費|現場管理費|共通仮設費|現場経費|値引|出精|端数|法定福利|安全管理費|経費計|諸経費等|調整費|割引)/;
function isOverheadName(name) {
  return OVERHEAD_RE.test(String(name || ''));
}

// 列見出しキーワード（各社様式の表記ゆれを広めに吸収。上のキーから順に1列1キー割当）。
//   ※ 公式様式(名称/摘要/数量/単位/単価/金額)はこの上位集合に含まれるので両用できる。
const COL_KEYS = {
  name:   ['名称', '品名', '名前', '工種', '工事名', '工事項目', '項目', '品目', '内容', '工事内容'],
  spec:   ['規格', '仕様', '形状', '寸法', '摘要', '摘 要'],
  qty:    ['数量', '員数', '数 量', '数　量'],
  unit:   ['単位'],
  price:  ['単価', '単 価', '単　価', '代価', '歩掛単価'],
  amount: ['金額', '金 額', '金　額', '価格', '合計金額'],
};

// 1行から列位置を検出（NFKC＋空白除去で照合）。1列につき最初に当たったキーを割り当てる。
function detectColsLenient(row) {
  const cols = {};
  for (let c = 0; c < (row || []).length; c++) {
    const t = String(row[c] ?? '').normalize('NFKC').replace(/\s/g, '');
    if (!t) continue;
    for (const key of Object.keys(COL_KEYS)) {
      if (cols[key] != null) continue;
      if (COL_KEYS[key].some((k) => t.includes(k.replace(/\s/g, '')))) { cols[key] = c; break; }
    }
  }
  return cols;
}

// ヘッダ行か（名称列 ＋ 単価or金額列があればヘッダとみなす）
function headerCols(row) {
  const c = detectColsLenient(row || []);
  return (c.name != null && (c.price != null || c.amount != null)) ? c : null;
}

// ── 類型1: 公式Excel（位置直読）──
//   シートごとに「データ行 → 単価列/数量列」のマップを作り、各 BOQ 行の物理行で単価を読む。
function buildSheetReadMap(ws) {
  const { rows, rowNums } = sheetRows(ws);
  const map = new Map(); // rowNum -> { priceCol, qtyCol, row }
  let priceCol = null, qtyCol = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const c = headerCols(row);
    if (c) {
      if (c.price != null) priceCol = c.price;
      if (c.qty != null) qtyCol = c.qty;
      continue;
    }
    map.set(rowNums[i], { priceCol, qtyCol, row });
  }
  return map;
}

function extractOfficial(wb, boqRows) {
  const maps = new Map();
  const getMap = (sn) => {
    if (!maps.has(sn)) { const ws = wb.Sheets[sn]; maps.set(sn, ws ? buildSheetReadMap(ws) : new Map()); }
    return maps.get(sn);
  };
  const cells = [];
  let total = 0;
  for (const b of boqRows) {
    if (!b.sheet || b.row == null) continue;
    const e = getMap(b.sheet).get(b.row);
    if (!e || e.priceCol == null) continue;
    const up = qnum(e.row[e.priceCol]);
    if (up == null || up === 0) continue;
    // 数量サニティ: 同行の数量が原本数量と大きく食い違えば行ずれ疑い → 要レビュー
    const qAtRow = e.qtyCol != null ? qnum(e.row[e.qtyCol]) : null;
    const qBoq = b.quantity_num;
    let match_type = 'qty', sim = 1.0;
    if (qBoq != null && qAtRow != null
        && Math.abs(Math.abs(qAtRow) - Math.abs(qBoq)) > Math.max(0.01, Math.abs(qBoq) * 0.01)) {
      match_type = 'pos_review'; sim = 0;
    }
    cells.push({ boq_row_id: b.boq_row_id, unit_price: Math.round(up), match_type, sim, source_label: `公式Excel ${b.sheet}!${b.row}` });
    if (qBoq != null) total += Math.round(up * Math.abs(qBoq));
  }
  return { cells, unmatched: [], excluded: [], extracted_total: Math.round(total), checksum: Math.round(total) };
}

// ── 類型2: 各社Excel（明細抽出＋ファジー照合）──
function extractVendorItems(wb) {
  const items = [];
  const excluded = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const { rows } = sheetRows(ws);
    let cols = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      const hc = headerCols(row);
      if (hc) { cols = hc; continue; }
      if (!cols) continue;
      const name = cols.name != null ? toText(row[cols.name]) : '';
      const spec = cols.spec != null ? toText(row[cols.spec]) : '';
      const qty = cols.qty != null ? qnum(row[cols.qty]) : null;
      const unit = cols.unit != null ? toText(row[cols.unit]) : '';
      let price = cols.price != null ? qnum(row[cols.price]) : null;
      const amount = cols.amount != null ? qnum(row[cols.amount]) : null;
      if (!name && price == null && amount == null) continue;   // 空行
      if (isSubtotalName(name)) continue;                        // 計 行
      if (price == null && amount != null && qty) price = amount / qty; // 単価欠落は 金額÷数量
      if (price == null || price === 0) continue;                // 単価のない行は比較対象外
      if (isOverheadName(name)) {
        excluded.push({ label: clean(name), amount: amount != null ? Math.round(amount) : null, reason: '経費/値引/調整等（BOQ細目に非対応）' });
        continue;
      }
      items.push({ name, spec, quantity: qty, unit, unit_price: price });
    }
  }
  return { items, excluded };
}

function buildIndex(boqRows) {
  const idx = new Map();
  const all = [];
  for (const b of boqRows) {
    const q = b.quantity_num;
    const u = unorm(b.unit);
    const entry = { boq_row_id: b.boq_row_id, name: clean(b.name), spec: clean(b.spec), unit: u, q };
    all.push(entry);
    if (q != null && u) {
      const key = `${Math.round(Math.abs(q) * 1000) / 1000}|${u}`;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(entry);
    }
  }
  return { idx, all };
}

function extractVendor(wb, boqRows) {
  const { idx, all } = buildIndex(boqRows);
  const qById = new Map(boqRows.map((b) => [b.boq_row_id, b.quantity_num]));
  const { items, excluded } = extractVendorItems(wb);

  const used = new Set();
  const cells = [];
  const pending = [];

  // Pass1: 数量+単位 完全一致（高信頼）
  for (const it of items) {
    const up = it.unit_price;
    if (!up) continue;
    const q = qnum(it.quantity);
    const u = unorm(it.unit);
    const qn = clean(it.name);
    const qs = clean(it.spec);
    let cands = (q != null && u) ? (idx.get(`${Math.round(Math.abs(q) * 1000) / 1000}|${u}`) || []) : [];
    if (!qn.includes('撤去')) {
      const f = cands.filter((c) => !c.name.includes('撤去'));
      cands = f.length ? f : cands;
    }
    cands = cands.filter((c) => !used.has(c.boq_row_id));
    if (!cands.length) { pending.push({ qn, qs, q, u, up }); continue; }
    if (cands.length > 1) {
      cands = [...cands].sort((a, b) => seqRatio(qn + qs, b.name + b.spec) - seqRatio(qn + qs, a.name + a.spec));
    }
    const c = cands[0];
    used.add(c.boq_row_id);
    cells.push({ boq_row_id: c.boq_row_id, unit_price: Math.round(up), match_type: 'qty', sim: 1.0, source_label: `${qn} ${qs}`.trim() });
  }

  // Pass2: 同単位優先で名称+仕様 類似フォールバック
  const unmatched = [];
  for (const p of pending) {
    let best = null, bs = 0;
    for (const c of all) {
      if (used.has(c.boq_row_id)) continue;
      if (!p.qn.includes('撤去') && c.name.includes('撤去')) continue;
      let sim = seqRatio(p.qn + p.qs, c.name + c.spec);
      if (p.u && c.unit === p.u) sim += 0.15;
      if (sim > bs) { bs = sim; best = c; }
    }
    if (best && bs >= 0.55) {
      used.add(best.boq_row_id);
      cells.push({ boq_row_id: best.boq_row_id, unit_price: Math.round(p.up), match_type: 'name', sim: Math.round(bs * 100) / 100, source_label: `${p.qn} ${p.qs}`.trim() });
    } else {
      unmatched.push({
        name: p.qn, spec: p.qs, quantity: p.q, unit: p.u, unit_price: Math.round(p.up),
        best_candidate: best ? `${best.name} ${best.spec}`.trim() : null,
        sim: best ? Math.round(bs * 100) / 100 : null,
      });
    }
  }

  // 検算合計 = 公式数量 × 各社単価（比較表と同じ算出基準）
  let total = 0;
  for (const c of cells) {
    const q = qById.get(c.boq_row_id);
    if (q != null) total += Math.round(c.unit_price * Math.abs(q));
  }
  return { cells, unmatched, excluded, extracted_total: Math.round(total), checksum: Math.round(total) };
}

/**
 * Excel 見積を直読抽出する。
 * @param {{ buffer: Buffer, boqRows: Array, formType: 'official'|'vendor' }} param
 *   boqRows = [{ boq_row_id, sheet, row, name, spec, quantity_num, unit, beppi_no }]
 * @returns {{cells, unmatched, excluded, extracted_total, checksum}}
 */
export function extractExcelQuote({ buffer, boqRows, formType }) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return formType === 'official'
    ? extractOfficial(wb, boqRows || [])
    : extractVendor(wb, boqRows || []);
}
