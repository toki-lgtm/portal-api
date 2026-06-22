// 数量書（工事費内訳明細書 .xlsx）解析 ── 階層保持版
//
// 国交省/防衛省 標準様式の内訳明細書は「レベルごとに別シート」で構成される：
//
//   種目別内訳(種目)        建物・工事単位          … シート「種目」
//     └ 科目別内訳(科目)    工種（直接仮設/防水改修…） … シート「科目」「科目 (2)」…
//        └ 細目別内訳(細目) 明細行（数量/単位/単価/金額）… シート「細目別内訳」「細目別内訳 (2)」…
//           └ 別紙明細(別紙) 複合単価の内訳（備考の別紙番号で紐付け）… シート「別紙明細」
//
// 旧版は全行を23個の固定工種へ寄せ「その他」でまとめていたが、本版は
// Excel の表記・順序をそのまま 4 階層ツリーとして保持する（その他バケット廃止）。
// 共通費（積上分）明細など種目配下に属さない明細も別枠ノードとして保持する。
//
// 出力 nodes[] は pre-order（読込順）のフラット配列。各ノードは level/path/seq を持ち、
// フロントはこれを使ってインデント・折りたたみのツリーを再構成する。
// 加えて、科目（＝工種）別の構成比率 summary と、施工計画書チェックリスト絞り込み用の
// 正規化工種集合 presentTrades を返す（工種別構成比率の維持）。
//
// 各ノードには書き戻し用の物理Excel行番号 excel_row（1始まり）と
// シート名 sheet_name が必ず付与される。
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
  [/内装|内部改修|床仕上|壁仕上|天井|ボード|クロス|畳|カーペット|フローリング|間仕切/, '内装'],
  [/外壁|外部改修/, '左官'],
  [/ユニット|家具|流し|厨房|洗面化粧|可動間仕切|サイン/, 'ユニット'],
  [/木工事|木製|造作/, '木'],
  [/地業|杭|山留|地盤改良|砕石|捨てコン/, '地業'],
  [/土工事|根切|土工|掘削|埋戻|残土/, '土工事'],
  [/仮設/, '仮設'],
  [/電気設備|電気工事|弱電|受変電|照明|動力/, '電気'],
  [/機械設備|給排水|衛生|空調|換気|ガス設備|消火|昇降機|エレベータ|ｴﾚﾍﾞｰﾀ/, '機械'],
  [/安全衛生|安全管理/, '安全'],
];

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

// セル値を1行テキストに（セル内改行 _x000D_ / \r / \n を空白へ畳む）
function toText(v) {
  if (v == null) return '';
  return String(v).replace(/_x000D_/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const pad = (n) => String(n).padStart(3, '0');

// 種目/科目の見出し文字列から建築面積を結合キーとして抽出（隊舎/庁舎の表記揺れに依存しない）
function areaKey(headerText) {
  const t = toText(headerText);
  const m = t.match(/建築面積[:：]?\s*([0-9,]+\.?[0-9]*)/);
  if (m) return m[1].replace(/,/g, '');
  return t.replace(/\s/g, '') || null; // 面積が無ければ見出し全体をキーに
}

// 「<...>」「(...)」「（...）」で囲まれた小見出し（撤去/地区名など）か
function isGroupLabel(name) {
  return /^[<(（＜【].*[>)）＞】]$/.test(name.trim());
}

// 小計・合計・経費・税の行か（明細として数えない見出し）
const SUBTOTAL_RE = /^(小計|合計|計|総計|総額|内訳)$/;
function isSubtotal(name) {
  const s = name.replace(/\s/g, '');
  return SUBTOTAL_RE.test(s);
}

// 別紙番号を抽出（例: 「別紙 00-0001」→ "00-0001"）
function beppiNo(remark) {
  const m = toText(remark).match(/別紙\s*([0-9]{1,3}-[0-9]{1,5})/);
  return m ? m[1] : null;
}

// ヘッダ行をキーワードで検出し、列位置（名称/摘要/数量/単位/単価/金額/備考）を決める
const HEADER_KEYS = {
  name:   ['名称', '名 称', '名　称', '名　　　称'],
  spec:   ['摘要', '摘 要', '規格', '仕様', '形状'],
  qty:    ['数量', '数 量', '数　量'],
  unit:   ['単位'],
  price:  ['単価', '単 価', '単  価', '代価'],
  amount: ['金額', '金 額', '金　額', '価格'],
  remark: ['備考', '備 考', '備　考'],
};

function detectCols(row) {
  const cols = {};
  for (let c = 0; c < row.length; c++) {
    const t = toText(row[c]).replace(/\s/g, '');
    if (!t) continue;
    for (const key of Object.keys(HEADER_KEYS)) {
      if (cols[key] != null) continue;
      if (HEADER_KEYS[key].some((k) => t.includes(k.replace(/\s/g, '')))) { cols[key] = c; break; }
    }
  }
  return cols;
}

// ヘッダ行か（名称列＋金額列が揃う）
function isHeaderRow(row) {
  const c = detectCols(row);
  return c.name != null && c.amount != null ? c : null;
}

// ブロック表題行か（B列が「…種目別内訳/科目別内訳/細目別内訳/別紙明細/…明細」で終わる）。
// 次ブロックの表題・情報行を当該ブロックの明細へ取り込まないための境界。
function isTitleRow(row) {
  const b = toText((row || [])[1]).replace(/\s/g, '');
  return !!b && /(内訳|明細)$/.test(b);
}

// シートの全行を { rows, rowNums } として返す。
// rows[i] は i 番目の行の配列（空行も含む）。
// rowNums[i] は rows[i] に対応する物理Excel行番号（1始まり）。
// blankrows:true にすることで配列indexと物理行番号が線形対応する。
function sheetRows(ws) {
  if (!ws || !ws['!ref']) return { rows: [], rowNums: [] };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const origin = range.s.r; // 先頭行の0始まりインデックス
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const rowNums = rows.map((_, i) => origin + i + 1); // 1始まり物理行番号
  return { rows, rowNums };
}

// 1ブロック（ヘッダ行〜次ヘッダ/シート末）を読み、明細行配列＋小見出し帯を返す。
// 戻り: { rows: [{name, spec, qty, unit, price, amount, remark, beppi_no, group_label, excel_row}], end }
function readBlock(rows, rowNums, headerIdx, cols) {
  const out = [];
  let group = null;
  let r = headerIdx + 1;
  for (; r < rows.length; r++) {
    const row = rows[r] || [];
    if (isHeaderRow(row) || isTitleRow(row)) break;    // 次ブロックのヘッダ/表題
    const name = cols.name != null ? toText(row[cols.name]) : '';
    const spec = cols.spec != null ? toText(row[cols.spec]) : '';
    const qty = cols.qty != null ? toNumber(row[cols.qty]) : null;
    const unit = cols.unit != null ? toText(row[cols.unit]) : '';
    const price = cols.price != null ? toNumber(row[cols.price]) : null;
    const amount = cols.amount != null ? toNumber(row[cols.amount]) : null;
    const remark = cols.remark != null ? toText(row[cols.remark]) : '';

    if (!name && amount == null && qty == null) continue;      // 空行
    if (isSubtotal(name)) continue;                            // 計 行は集計しない
    if (isGroupLabel(name) && amount == null) { group = name; continue; } // 小見出し帯

    out.push({
      name: name || '(名称なし)', spec: spec || null, qty, unit: unit || null,
      price, amount: amount != null ? Math.round(amount) : null,
      remark: remark || null, beppi_no: beppiNo(remark), group_label: group,
      excel_row: rowNums[r],
    });
  }
  return { rows: out, end: r };
}

// シート内の全ブロックを { taneArea, kamoku, rows } で返す（細目別内訳/別紙明細用）
// sheetName を受け取り、各 item に sheet_name を付与する。
function parseBlocks(ws, sheetName) {
  const { rows, rowNums } = sheetRows(ws);
  const blocks = [];
  let r = 0;
  while (r < rows.length) {
    const cols = isHeaderRow(rows[r] || []);
    if (!cols) { r++; continue; }
    // ヘッダ直前の情報行: B列=種目名, D列=科目名
    const info = rows[r - 1] || [];
    const taneText = toText(info[1]);
    const kamoku = toText(info[3]);
    const { rows: items, end } = readBlock(rows, rowNums, r, cols);
    // 各 item に sheet_name を付与
    const itemsWithSheet = items.map((it) => ({ ...it, sheet_name: sheetName || null }));
    blocks.push({ taneArea: areaKey(taneText), taneText, kamoku, rows: itemsWithSheet });
    r = end;
  }
  return blocks;
}

// 種目シート: 種目（建物単位）の一覧 [{name, area, qty, unit, amount, group_label, excel_row, sheet_name}]
function parseTane(ws, sheetName) {
  const { rows, rowNums } = sheetRows(ws);
  let cols = null, hi = -1;
  for (let r = 0; r < rows.length; r++) { const c = isHeaderRow(rows[r] || []); if (c) { cols = c; hi = r; break; } }
  if (!cols) return [];
  const { rows: items } = readBlock(rows, rowNums, hi, cols);
  return items.map((it) => ({
    name: it.name, area: areaKey(it.name), qty: it.qty, unit: it.unit,
    amount: it.amount, group_label: it.group_label,
    excel_row: it.excel_row, sheet_name: sheetName || null,
  }));
}

// 科目シート: ある種目の科目（工種）一覧。area は見出しB2から、items は科目行。
// sheetName を受け取り、各 item に sheet_name を付与する。
function parseKamoku(ws, sheetName) {
  const { rows, rowNums } = sheetRows(ws);
  let cols = null, hi = -1;
  for (let r = 0; r < rows.length; r++) { const c = isHeaderRow(rows[r] || []); if (c) { cols = c; hi = r; break; } }
  if (!cols) return null;
  const area = areaKey(toText((rows[hi - 1] || [])[1]));
  const { rows: items } = readBlock(rows, rowNums, hi, cols);
  const itemsWithSheet = items.map((it) => ({ ...it, sheet_name: sheetName || null }));
  return { area, items: itemsWithSheet };
}

// 別紙明細: 別紙番号 → 内訳行配列。番号付きの親行に続く行を計まで内訳とする。
// sheetName を受け取り、各 item に sheet_name を付与する。
function parseBeppi(ws, sheetName) {
  const { rows, rowNums } = sheetRows(ws);
  const map = new Map();
  let r = 0;
  while (r < rows.length) {
    const cols = isHeaderRow(rows[r] || []);
    if (!cols) { r++; continue; }
    const { rows: items, end } = readBlock(rows, rowNums, r, cols);
    // ブロック内を走査: 別紙番号を持つ行が親、その後ろ〜次の別紙番号/末尾が内訳
    let curNo = null;
    for (const it of items) {
      const itWithSheet = { ...it, sheet_name: sheetName || null };
      if (itWithSheet.beppi_no) { curNo = itWithSheet.beppi_no; if (!map.has(curNo)) map.set(curNo, []); continue; }
      if (curNo) map.get(curNo).push(itWithSheet);
    }
    r = end;
  }
  return map;
}

// シート名の正規化（全角空白/連番表記の揺れ吸収）
const norm = (s) => toText(s).replace(/\s/g, '');

export function parseBoqFromXlsx(buffer, sourceFile) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const names = wb.SheetNames;
  const find = (re) => names.filter((n) => re.test(norm(n)));

  const taneSheet = find(/^種目/)[0];
  const kamokuSheets = find(/^科目/);
  const detailSheets = find(/^細目別内訳/);
  const beppiSheet = find(/^別紙明細/)[0];

  const tane = taneSheet ? parseTane(wb.Sheets[taneSheet], taneSheet) : [];
  const kamokuByArea = new Map();
  for (const sn of kamokuSheets) {
    const k = parseKamoku(wb.Sheets[sn], sn);
    if (k && k.area) kamokuByArea.set(k.area, k.items);
  }
  // 細目ブロックを (種目area, 科目名) で索引。共通費など種目に紐付かないブロックは別枠へ。
  const detailByArea = new Map();   // area -> { kamoku -> rows[] }（同一科目の連続ブロックは連結）
  const orphanBlocks = [];          // 種目に属さない明細（共通費 積上分など）
  for (const sn of detailSheets) {
    for (const b of parseBlocks(wb.Sheets[sn], sn)) {
      const matchesTane = b.taneArea && tane.some((t) => t.area === b.taneArea);
      if (matchesTane && b.kamoku) {
        if (!detailByArea.has(b.taneArea)) detailByArea.set(b.taneArea, new Map());
        const m = detailByArea.get(b.taneArea);
        m.set(b.kamoku, (m.get(b.kamoku) || []).concat(b.rows));
      } else {
        const title = toText(b.taneText || b.kamoku || sn);
        const prev = orphanBlocks[orphanBlocks.length - 1];
        if (prev && prev.title === title) prev.rows = prev.rows.concat(b.rows); // 連続する同名ブロックは連結
        else orphanBlocks.push({ title, rows: b.rows });
      }
    }
  }
  const beppiMap = beppiSheet ? parseBeppi(wb.Sheets[beppiSheet], beppiSheet) : new Map();

  // ── ツリー構築（pre-order フラット配列）──
  const nodes = [];
  let sort = 0;
  const push = (n) => { nodes.push({ ...n, sort_order: sort++, sheet_name: n.sheet_name ?? null, excel_row: n.excel_row ?? null, source_file: sourceFile || null }); };

  let seqT = 0;
  for (const t of tane) {
    seqT++;
    const pathT = pad(seqT);
    push({
      level: 0, kind: '種目', path: pathT, seq: seqT, group_label: t.group_label,
      item_name: t.name, spec: null, quantity: t.qty, unit: t.unit, unit_price: null,
      amount: t.amount, beppi_no: null, trade: null, raw_category: t.name,
      sheet_name: t.sheet_name, excel_row: t.excel_row,
    });

    const kamokuItems = kamokuByArea.get(t.area) || [];
    const detailMap = detailByArea.get(t.area) || new Map();
    let seqK = 0;
    for (const k of kamokuItems) {
      seqK++;
      const pathK = `${pathT}.${pad(seqK)}`;
      const trade = normalizeTrade(k.name);
      push({
        level: 1, kind: '科目', path: pathK, seq: seqK, group_label: k.group_label,
        item_name: k.name, spec: null, quantity: k.qty, unit: k.unit, unit_price: null,
        amount: k.amount, beppi_no: null, trade, raw_category: k.name,
        sheet_name: k.sheet_name, excel_row: k.excel_row,
      });

      const detailRows = detailMap.get(k.name) || [];
      let seqD = 0;
      for (const d of detailRows) {
        seqD++;
        const pathD = `${pathK}.${pad(seqD)}`;
        push({
          level: 2, kind: '細目', path: pathD, seq: seqD, group_label: d.group_label,
          item_name: d.name, spec: d.spec, quantity: d.qty, unit: d.unit, unit_price: d.price,
          amount: d.amount, beppi_no: d.beppi_no, trade, raw_category: k.name,
          sheet_name: d.sheet_name, excel_row: d.excel_row,
        });
        const sub = d.beppi_no ? beppiMap.get(d.beppi_no) : null;
        if (sub && sub.length) {
          let seqB = 0;
          for (const b of sub) {
            seqB++;
            push({
              level: 3, kind: '別紙', path: `${pathD}.${pad(seqB)}`, seq: seqB, group_label: b.group_label,
              item_name: b.name, spec: b.spec, quantity: b.qty, unit: b.unit, unit_price: b.price,
              amount: b.amount, beppi_no: d.beppi_no, trade, raw_category: k.name,
              sheet_name: b.sheet_name, excel_row: b.excel_row,
            });
          }
        }
      }
    }
  }

  // ── 種目に紐付かない明細（共通費 積上分など）を別枠の最上位ノードとして保持 ──
  for (const ob of orphanBlocks) {
    if (!ob.rows.length) continue;
    seqT++;
    const pathT = pad(seqT);
    const groupTotal = ob.rows.reduce((s, x) => s + (x.amount || 0), 0);
    push({
      level: 0, kind: '共通費', path: pathT, seq: seqT, group_label: null,
      item_name: toText(ob.title), spec: null, quantity: null, unit: null, unit_price: null,
      amount: groupTotal || null, beppi_no: null, trade: null, raw_category: toText(ob.title),
      sheet_name: null, excel_row: null,
    });
    let seqD = 0;
    for (const d of ob.rows) {
      seqD++;
      push({
        level: 2, kind: '細目', path: `${pathT}.${pad(seqD)}`, seq: seqD, group_label: d.group_label,
        item_name: d.name, spec: d.spec, quantity: d.qty, unit: d.unit, unit_price: d.price,
        amount: d.amount, beppi_no: d.beppi_no, trade: null, raw_category: toText(ob.title),
        sheet_name: d.sheet_name, excel_row: d.excel_row,
      });
    }
  }

  // ── 工種（科目）別 構成比率：科目ノードの金額を科目名で合算（その他で括らない）──
  const directTotal = tane.reduce((s, t) => s + (t.amount || 0), 0);
  const byKamoku = new Map();
  for (const n of nodes) {
    if (n.kind !== '科目' || n.amount == null) continue;
    const key = n.item_name;
    const cur = byKamoku.get(key) || { trade: key, canonical: normalizeTrade(key), amount: 0, item_count: 0 };
    cur.amount += n.amount;
    cur.item_count += 1;
    byKamoku.set(key, cur);
  }
  const summary = Array.from(byKamoku.values())
    .map((t) => ({
      trade: t.trade, canonical: t.canonical, amount: t.amount,
      ratio: directTotal > 0 ? t.amount / directTotal : null, item_count: t.item_count,
    }))
    .sort((a, b) => b.amount - a.amount);

  // ── 各ノードに構成比率を付与（別紙明細まで）──
  //   ratio_total  : 対 直接工事費（共通費の枝は対象外＝null）
  //   ratio_parent : 対 親ノード（その内訳での割合。最上位は対 直接工事費と同義）
  const amtByPath = new Map(nodes.map((n) => [n.path, n.amount]));
  const kindByPath = new Map(nodes.map((n) => [n.path, n.kind]));
  for (const n of nodes) {
    const parts = String(n.path).split('.');
    const underDirect = kindByPath.get(parts[0]) === '種目';   // 直接工事費の枝か
    n.ratio_total = (underDirect && directTotal > 0 && n.amount != null) ? n.amount / directTotal : null;
    if (parts.length > 1) {
      const pAmt = amtByPath.get(parts.slice(0, -1).join('.'));
      n.ratio_parent = (pAmt > 0 && n.amount != null) ? n.amount / pAmt : null;
    } else {
      n.ratio_parent = n.ratio_total;                          // 最上位ノード
    }
  }

  // チェックリスト絞り込み用：出現した正規化工種の集合
  const presentTrades = Array.from(new Set(summary.map((s) => s.canonical).filter(Boolean)));

  const counts = {
    種目: nodes.filter((n) => n.kind === '種目').length,
    科目: nodes.filter((n) => n.kind === '科目').length,
    細目: nodes.filter((n) => n.kind === '細目').length,
    別紙: nodes.filter((n) => n.kind === '別紙').length,
    共通費: nodes.filter((n) => n.kind === '共通費').length,
  };

  return {
    nodes,
    summary,
    total: directTotal,
    mode: nodes.length ? 'hierarchical' : 'empty',
    presentTrades,
    counts,
    lineCount: nodes.length,
  };
}
