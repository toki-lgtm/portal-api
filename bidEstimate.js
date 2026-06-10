// 積算 Excel 解析（ATLUS 等の出力 .xlsx から「積算金額(税抜)」を抽出）
// 案件ごとに書式が異なるため、固定セルではなくキーワードで金額欄を探す。
// 入札は税抜で記載するため、税込・消費税の欄は除外し税抜を優先する。
import ExcelJS from 'exceljs';

export const ESTIMATE_LABEL_PRIORITY = [
  '工事価格', '工事費計', '本工事費', '請負金額', '設計金額', '工事費', '工事費総額',
  '合計金額', '総合計', '合計', '総額', '金額',
];

// セル値を整数に。数式セルは結果(result)を、文字列は数字のみ抽出して使う。
export function cellNumber(cell) {
  if (cell == null) return null;
  let v = cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) v = v.result;        // 数式セルのキャッシュ結果
    else if ('text' in v) v = v.text;        // ハイパーリンク等
    else return null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === 'string') {
    const digits = v.replace(/[^0-9.]/g, '');
    if (!digits) return null;
    const n = Math.round(Number(digits));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// セルの表示テキスト（リッチテキスト・数式結果にも対応）
export function cellText(cell) {
  if (cell == null) return '';
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    return '';
  }
  return v == null ? '' : String(v);
}

// ラベルセルの近傍（右方向→直下）から最初の妥当な金額を拾う
export function findAmountNear(ws, rowNumber, colNumber) {
  const row = ws.getRow(rowNumber);
  for (let c = colNumber + 1; c <= colNumber + 12; c++) {
    const n = cellNumber(row.getCell(c));
    if (n != null) return n;
  }
  for (let r = rowNumber + 1; r <= rowNumber + 3; r++) {
    const n = cellNumber(ws.getRow(r).getCell(colNumber));
    if (n != null) return n;
  }
  return null;
}

export async function parseEstimateFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // head=ラベル先頭がキーワード（工事価格 / 合計金額 / 工事費計 等の総額系・信頼度高）
  // embedded=キーワードを含むだけ（直接工事費 等の小計系・head が皆無のときだけ採用）
  const head = [];
  const embedded = [];

  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = cellText(cell).replace(/\s/g, '');
        if (!text) return;
        // 税込・消費税の欄は積算金額(税抜)としては採用しない
        if (/税込|消費税/.test(text)) return;

        let idx = ESTIMATE_LABEL_PRIORITY.findIndex((k) => text.startsWith(k));
        const headMatch = idx !== -1;
        if (idx === -1) idx = ESTIMATE_LABEL_PRIORITY.findIndex((k) => text.includes(k));
        if (idx === -1) return;

        const amount = findAmountNear(ws, rowNumber, colNumber);
        if (amount == null || amount < 1000) return; // 金額として最低限の大きさ

        // 「税抜」と明記された欄は最優先（priority を引き下げる）
        const priority = idx - (/税抜/.test(text) ? 0.5 : 0);
        const cand = { label: ESTIMATE_LABEL_PRIORITY[idx], priority, amount, sheet: ws.name };
        (headMatch ? head : embedded).push(cand);
      });
    });
  });

  const pool = head.length ? head : embedded;
  if (!pool.length) return { amount: null, label: null, candidates: [] };
  // 優先度（小さいほど上位）→ 金額が大きい順
  pool.sort((a, b) => a.priority - b.priority || b.amount - a.amount);
  const best = pool[0];
  return {
    amount: best.amount,
    label: best.label,
    candidates: pool.slice(0, 8).map((c) => ({ label: c.label, amount: c.amount, sheet: c.sheet })),
  };
}
