// SheetJS удаляет служебные поля у каждой ячейки XLS (`delete line.ixfe; delete line.XF`).
// Из-за delete V8 переводит миллионы объектов ячеек в «словарный» режим (~480 байт на ячейку),
// и 35-мегабайтный XLS требует около 2 ГБ памяти. Присваивание undefined сохраняет быстрые объекты.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const targets = [
  ['node_modules/@e965/xlsx/xlsx.mjs', 'delete line.ixfe; delete line.XF;', 'line.ixfe = undefined; line.XF = undefined;'],
  ['node_modules/@e965/xlsx/xlsx.js',  'delete line.ixfe; delete line.XF;', 'line.ixfe = undefined; line.XF = undefined;'],
  ['public/vendor/xlsx.full.min.js',   'delete r.ixfe;delete r.XF;',        'r.ixfe=void 0;r.XF=void 0;'],
];
for (const [path, from, to] of targets) {
  const file = fileURLToPath(new URL(path, root));
  let text;
  try { text = await readFile(file, 'utf8'); } catch { console.warn(`patch-xlsx: нет ${path}`); continue; }
  if (text.includes(to)) { console.log(`patch-xlsx: ${path} уже исправлен`); continue; }
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`patch-xlsx: в ${path} найдено ${count} совпадений, ожидалось 1 — проверьте версию SheetJS`);
  await writeFile(file, text.replace(from, to));
  console.log(`patch-xlsx: ${path} исправлен`);
}
