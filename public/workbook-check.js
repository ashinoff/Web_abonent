// Read the monthly workbook without applying the subscriber schema or analysing it.
export function inspectMonthlyWorkbook(buffer, XLSX) {
  const bytes = new Uint8Array(buffer);
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => bytes[i] === v);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const biff = bytes[0] === 9 && [0, 2, 4, 8].includes(bytes[1]);
  if (!ole && !zip && !biff) throw new Error('Файл не является книгой Excel. Выгрузите его заново в формате XLS.');
  const book = XLSX.read(buffer, { type: 'array', cellHTML: false, cellText: false, sheetRows: 100002 });
  let populated = 0;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r > 100000 || range.e.c > 255 || sheet['!fullref']) throw new Error('Файл слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
    if (Object.keys(sheet).some(key => !key.startsWith('!') && sheet[key].v != null && sheet[key].v !== '')) populated++;
  }
  if (!populated) throw new Error('В файле нет заполненных листов.');
  return { sheets: populated };
}
