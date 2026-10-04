import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import XLSX from '@e965/xlsx';

const run = promisify(execFile);
const before = 'delete r.ixfe;delete r.XF;';
const after = 'r.ixfe=void 0;r.XF=void 0;';

test('patched browser XLS/XLSX reader retains the original parsed workbook data', async () => {
  const vendor = await readFile(new URL('../public/vendor/xlsx.full.min.js', import.meta.url), 'utf8');
  assert.equal(vendor.split(after).length - 1, 1);
  assert.ok(!vendor.includes(before));
  const load = source => {
    const context = vm.createContext({ Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, console });
    vm.runInContext(source, context);
    return context.XLSX;
  };
  const original = load(vendor.replace(after, before)), patched = load(vendor);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Полезный отпуск за Январь 2022 г. - Февраль 2022 г.'],
    ['ЛС', 'ТУ', 'Январь 2022', 'Февраль 2022', 'Примечание'],
    ['000123', 'Точка №1', 0, 15.75, 'Проверить'],
    ['000123', 'Точка №1', null, 15.75, ''],
    [42, 'Точка №2', -2, 0, 'Текст'],
  ]);
  sheet.A5.z = '000000';
  sheet['!merges'] = [{ s:{r:0,c:0},e:{r:0,c:4} }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Лист 1');
  for (const bookType of ['biff8','xlsx']) {
    const buffer = XLSX.write(workbook, {type:'buffer',bookType});
    const options = {type:'array',dense:true,cellNF:true,cellText:true,cellFormula:false,cellStyles:true};
    assert.equal(JSON.stringify(patched.read(buffer, options)), JSON.stringify(original.read(buffer, options)), bookType);
  }
});

test('postinstall patch is repeatable and rejects an unexpected SheetJS source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abonent-patch-test-'));
  try {
    for (const directory of ['scripts','node_modules/@e965/xlsx','public/vendor']) await mkdir(join(root,directory), {recursive:true});
    await writeFile(join(root,'scripts/patch-xlsx.mjs'), await readFile(new URL('../scripts/patch-xlsx.mjs', import.meta.url)));
    for (const name of ['xlsx.js','xlsx.mjs']) await writeFile(join(root,'node_modules/@e965/xlsx',name),'delete line.ixfe; delete line.XF;');
    await writeFile(join(root,'public/vendor/xlsx.full.min.js'),before);
    await run(process.execPath,[join(root,'scripts/patch-xlsx.mjs')]);
    const files=['node_modules/@e965/xlsx/xlsx.js','node_modules/@e965/xlsx/xlsx.mjs','public/vendor/xlsx.full.min.js'];
    const once=await Promise.all(files.map(path=>readFile(join(root,path),'utf8')));
    await run(process.execPath,[join(root,'scripts/patch-xlsx.mjs')]);
    assert.deepEqual(await Promise.all(files.map(path=>readFile(join(root,path),'utf8'))),once);
    await writeFile(join(root,'node_modules/@e965/xlsx/xlsx.mjs'),'unexpected source');
    await assert.rejects(run(process.execPath,[join(root,'scripts/patch-xlsx.mjs')]), /найдено 0 совпадений/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
