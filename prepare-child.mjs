import { readFile, writeFile } from 'node:fs/promises';
import { prepareWorkbook } from './prepared-workbook.mjs';

try {
  const [, , path, output, role, filename] = process.argv;
  if (!path || !output || !['registry', 'consumption', 'incoming'].includes(role)) throw new Error('Некорректный запрос подготовки.');
  const workbook = await readFile(path);
  await writeFile(output, JSON.stringify(prepareWorkbook(workbook, role, filename)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
