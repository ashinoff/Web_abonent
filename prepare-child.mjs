import { readFile } from 'node:fs/promises';
import { prepareWorkbook } from './prepared-workbook.mjs';

try {
  const [, , path, role, filename] = process.argv;
  if (!path || !['registry', 'consumption', 'incoming'].includes(role)) throw new Error('Некорректный запрос подготовки.');
  const workbook = await readFile(path);
  process.stdout.write(JSON.stringify(prepareWorkbook(workbook, role, filename)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
