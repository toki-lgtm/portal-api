// 積算 Excel 解析（ATLUS 等の出力 .xlsx から「積算金額(税抜)」を抽出）
//
// ExcelJS は ATLUS 出力の xlsx を読めず（"Invalid row number in model"）落ちるため、
// より寛容な SheetJS(xlsx) でセルを走査する。案件ごとに書式が違うので固定セルでは
// なくキーワードで金額欄を探す。入札は税抜で記載するため税込・消費税欄は除外する。
//
// ラベルは2段階で評価する:
//   PRIMARY  = 御見積金額/工事価格/請負金額 等の「総額系」（表紙・総括の最終金額）。最優先。
//   SECONDARY= 合計/工事費/金額 等。PRIMARY が皆無のときだけ採用（代価表の小計を拾いやすいので弱め）。
import * as XLSX from 'xlsx';

// includes 判定なので「御見積金額」は '見積金額' で拾える。順序＝優先度（小さいほど上位）。
export const ESTIMATE_LABELS_PRIMARY = [
  '工事価格', '請負代金額', '請負金額', '見積金額', '入札価格', '工事費計', '設計金額',
];
export const ESTIMATE_LABELS_SECONDARY = [
  '合計金額', '総合計', '工事費合計', '合計', '総額', '工事費', '金額',
];

// セル値を整数に。数値はそのまま、文字列は数字のみ抽出。SheetJS は数式セルでも .v に
// キャッシュ結果を持つためそれを使う。
export function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const digits = String(v).replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const n = Math.round(Number(digits));
  return Number.isFinite(n) ? n : null;
}

export function toText(v) {
  return v == null ? '' : String(v);
}

// ラベルセルの近傍（右方向→直下）から最初の妥当な金額を拾う
function findAmountNear(ws, R, C, range) {
  for (let c = C + 1; c <= Math.min(C + 12, range.e.c); c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: R, c })];
    const n = cell ? toNumber(cell.v) : null;
    if (n != null) return n;
  }
  for (let r = R + 1; r <= Math.min(R + 3, range.e.r); r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: C })];
    const n = cell ? toNumber(cell.v) : null;
    if (n != null) return n;
  }
  return null;
}

export async function parseEstimateFromXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const candidates = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (!cell) continue;
        const text = toText(cell.v).replace(/\s/g, '');
        if (!text) continue;
        // 税込・消費税の欄は積算金額(税抜)としては採用しない
        if (/税込|消費税/.test(text)) continue;

        let tier = 0;
        let pidx = ESTIMATE_LABELS_PRIMARY.findIndex((k) => text.includes(k));
        if (pidx !== -1) tier = 1;
        else {
          pidx = ESTIMATE_LABELS_SECONDARY.findIndex((k) => text.includes(k));
          if (pidx !== -1) tier = 2;
        }
        if (tier === 0) continue;

        const amount = findAmountNear(ws, R, C, range);
        if (amount == null || amount < 1000) continue; // 金額として最低限の大きさ

        const label = (tier === 1 ? ESTIMATE_LABELS_PRIMARY : ESTIMATE_LABELS_SECONDARY)[pidx];
        const taxBonus = /税抜/.test(text) ? 0.5 : 0; // 「税抜」明記は優先
        candidates.push({ tier, priority: pidx - taxBonus, amount, label, sheet: name });
      }
    }
  }

  if (!candidates.length) return { amount: null, label: null, candidates: [] };

  // PRIMARY があればそれだけで判定。無ければ SECONDARY 全体で。
  const primary = candidates.filter((c) => c.tier === 1);
  const pool = primary.length ? primary : candidates;
  // 優先度（小さいほど上位）→ 金額が大きい順（総額は小計より大きい）
  pool.sort((a, b) => a.priority - b.priority || b.amount - a.amount);
  const best = pool[0];

  return {
    amount: best.amount,
    label: best.label,
    candidates: pool.slice(0, 8).map((c) => ({ label: c.label, amount: c.amount, sheet: c.sheet })),
  };
}
