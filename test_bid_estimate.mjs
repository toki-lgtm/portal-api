// 積算Excel解析の自動テスト（合成データ）。
//   node test_bid_estimate.mjs
// 試験用ファイル sample_estimate.xlsx も書き出す（ブラウザでの実機確認用）。
import ExcelJS from 'exceljs';
import { parseEstimateFromXlsx } from './bidEstimate.js';

function build(rows, { withFormulaTotal = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('工事費総括表');
  rows.forEach((r) => ws.addRow(r));
  return wb;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra ?? ''}`); }
}

async function run() {
  // ケース1: ATLUS的な総括表。工事価格(税抜)=12,345,000 / 消費税 / 工事費総額(税込)=13,579,500
  {
    const wb = build([
      ['工事費総括表'],
      ['名称', '金額'],
      ['純工事費', 10000000],
      ['一般管理費等', 2345000],
      ['工事価格', 12345000],          // ← 税抜・これを採用してほしい
      ['消費税相当額', 1234500],
      ['工事費総額（税込）', 13579500], // ← 税込・除外されるべき
    ]);
    const buf = await wb.xlsx.writeBuffer();
    const r = await parseEstimateFromXlsx(Buffer.from(buf));
    console.log('ケース1:', JSON.stringify(r.amount), r.label);
    check('工事価格(税抜)を採用', r.amount === 12345000, `got ${r.amount}`);
    check('税込を採用していない', r.amount !== 13579500);
    // 試験用ファイルとして保存
    await wb.xlsx.writeFile('sample_estimate.xlsx');
  }

  // ケース2: 金額が数式セル（=SUM）で右隣にあるパターン
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('内訳');
    ws.addRow(['項目', '金額']);
    ws.addRow(['直接工事費', 8000000]);
    ws.addRow(['諸経費', 1500000]);
    const row = ws.addRow(['合計', null]);
    row.getCell(2).value = { formula: 'SUM(B2:B3)', result: 9500000 };
    const buf = await wb.xlsx.writeBuffer();
    const r = await parseEstimateFromXlsx(Buffer.from(buf));
    console.log('ケース2:', JSON.stringify(r.amount), r.label);
    check('数式セルの結果9,500,000を取得', r.amount === 9500000, `got ${r.amount}`);
  }

  // ケース3: ラベルの直下に金額があるパターン（縦配置）
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['設計金額']);
    ws.addRow([7777000]);
    const buf = await wb.xlsx.writeBuffer();
    const r = await parseEstimateFromXlsx(Buffer.from(buf));
    console.log('ケース3:', JSON.stringify(r.amount), r.label);
    check('直下の金額7,777,000を取得', r.amount === 7777000, `got ${r.amount}`);
  }

  // ケース4: 該当ラベルなし → null（手入力フォールバック）
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['備考', 'テスト']);
    ws.addRow(['担当', '中原']);
    const buf = await wb.xlsx.writeBuffer();
    const r = await parseEstimateFromXlsx(Buffer.from(buf));
    console.log('ケース4:', JSON.stringify(r.amount));
    check('金額なしはnull', r.amount === null, `got ${r.amount}`);
  }

  console.log(`\n結果: ${pass} pass / ${fail} fail`);
  console.log('試験用ファイル: sample_estimate.xlsx を書き出しました（ブラウザ実機確認用）');
  process.exit(fail ? 1 : 0);
}

run();
