// HR → Reports → bank transfer list: the Excel file for one bank channel.
//
// Why this is not lib/exporter.js. The shared exporter turns any cell that looks like a number into
// an Excel number and gives whole numbers the '#,##0' format. For an account number that is wrong
// three ways: leading zeros vanish, anything past 15 digits loses its last digits, and the number is
// shown with thousands commas. On a file that drives real transfers an account number must stay
// text. So this writes its own small workbook (exceljs, loaded on the click like the exporter's),
// in the exporter's look, with the account and IFSC columns as text and the amount as a 2-dp number.
//
// Nothing here logs. The full account numbers come from GET /hr/people/:id (operator and above)
// and go straight into the file.
import { auth } from '../../api.js';

const INK = 'FF1D1D1F';
const FAINT = 'FF86868B';
const ACCENT = 'FF007AFF';
const ACCENT_DEEP = 'FF0064D2';

// rows: [{ holder, account, ifsc, amount ('1234.50'), reference }], total: '1234.50' (exact string).
export async function downloadBankList({ fileName, title, meta = [], rows, total }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CI ERP — Colour Impressions';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(title).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Bank list');
  const user = auth?.user || null;
  const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  ws.getCell('A1').value = 'Colour Impressions';
  ws.getCell('A1').font = { name: 'Calibri', size: 15, bold: true, color: { argb: ACCENT } };
  ws.getCell('A2').value = title;
  ws.getCell('A2').font = { name: 'Calibri', size: 12, bold: true, color: { argb: INK } };
  ws.getCell('A3').value = [...meta.filter(Boolean), `Generated ${stamp}${user?.name ? ` by ${user.name}` : ''}`].join('   ·   ');
  ws.getCell('A3').font = { name: 'Calibri', size: 9, color: { argb: FAINT } };
  [1, 2, 3].forEach(r => ws.mergeCells(r, 1, r, 6));

  const head = ws.getRow(5);
  head.values = ['#', 'Beneficiary', 'Account number', 'IFSC', 'Amount (INR)', 'Reference'];
  head.eachCell(cell => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
    cell.border = { bottom: { style: 'medium', color: { argb: ACCENT_DEEP } } };
  });
  head.height = 20;

  rows.forEach((r, i) => {
    const row = ws.getRow(6 + i);
    // Text cells stay strings with the '@' format; the amount is the only number.
    row.getCell(1).value = i + 1;
    row.getCell(2).value = String(r.holder ?? '');
    row.getCell(3).value = String(r.account ?? '');
    row.getCell(3).numFmt = '@';
    row.getCell(4).value = String(r.ifsc ?? '');
    row.getCell(4).numFmt = '@';
    row.getCell(5).value = Number(r.amount);
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(6).value = String(r.reference ?? '');
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 10, color: { argb: INK } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };
    });
  });

  const at = 6 + rows.length;
  const sum = ws.getRow(at);
  sum.getCell(2).value = 'Total';
  sum.getCell(5).value = Number(total);
  sum.getCell(5).numFmt = '#,##0.00';
  sum.eachCell(cell => { cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK } }; });

  [5, 34, 24, 14, 16, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 5 }];

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${String(fileName).replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
