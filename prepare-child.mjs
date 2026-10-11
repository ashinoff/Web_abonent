import { readFile, writeFile } from 'node:fs/promises';
import { prepareWorkbook } from './prepared-workbook.mjs';
import { sourceRoleKeys } from './public/source.js';

try {
  const [, , path, output, role, filename] = process.argv;
  if (!path || !output || !sourceRoleKeys.includes(role)) throw new Error('Некорректный запрос подготовки.');
  const workbook = await readFile(path);
  await writeFile(output, JSON.stringify(prepareWorkbook(workbook, role, filename)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
