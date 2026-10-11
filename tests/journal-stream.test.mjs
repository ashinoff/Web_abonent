import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, open } from 'node:fs/promises';
import { createDeflateRaw } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import XLSX from '@e965/xlsx';
import { readEventJournalXLSX, streamJournalTimestamp } from '../journal-stream.mjs';
import { readJournalWorkbook, parseJournalTimestamp } from '../public/journals.js';
import { preparationChildFlags } from '../prepared-service.mjs';

const headers = ['ТУ','Тип ПУ','Серийный','Абонент','Лимит','Дата и время','Тип','Событие','Инициатор','Дополнительная информация'];
const compactHeaders = ['Серийный','Дата и время','Дополнительная информация'];
const description = 'Вскрытый элемент устройства "Клеммная крышка"';
const event = (serial, at, info = description) => ['private-point','private-model',serial,'private-name','private-limit',at,'private-type','private-event','private-author',info];
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[character]));
const inline = (reference, value) => `<c r="${reference}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
const rowXML = (number, values) => `<row r="${number}">${values.map(([col,value]) => inline(col+number,value)).join('')}</row>`;
const worksheet = rows => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

async function fixture(t, sheets, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-stream-test-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  if (options.date1904) book.Workbook = { WBProps:{ date1904:true } };
  options.mutate?.(book);
  const bytes = XLSX.write(book, { type:'buffer', bookType:options.bookType || 'xlsx', bookSST:options.shared || false });
  const path = join(dir, options.bookType === 'biff8' ? 'events.xls' : 'events.xlsx');
  await writeFile(path, bytes);
  return { path, bytes, dir };
}

// A tiny ZIP writer is confined to synthetic test fixtures. It writes each
// deflated entry incrementally, so the 600k-row regression never builds a full
// worksheet or workbook in the test process either.
const crcTable = Array.from({ length:256 }, (_, index) => {
  let value = index; for (let bit=0; bit<8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
async function zipFixture(path, entries) {
  const file = await open(path, 'w'), central = []; let position = 0;
  const write = async bytes => { let offset=0; while (offset<bytes.length) { const result=await file.write(bytes,offset,bytes.length-offset,position); offset+=result.bytesWritten; position+=result.bytesWritten; } };
  try {
    for (const [name, contents, declaredSize] of entries) {
      const filename = Buffer.from(name), start = position, header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(8,6); header.writeUInt16LE(8,8); header.writeUInt16LE(filename.length,26);
      await write(header); await write(filename);
      let crc=0xffffffff, size=0, compressed=0;
      const input = typeof contents === 'string' || Buffer.isBuffer(contents) ? [Buffer.from(contents)] : contents;
      const measure = new Transform({ transform(chunk, encoding, callback) {
        size+=chunk.length; for (const byte of chunk) crc=crcTable[(crc^byte)&255]^(crc>>>8); callback(null,chunk);
      } });
      const source = Readable.from(input), deflate = createDeflateRaw();
      source.on('error',error=>deflate.destroy(error)); measure.on('error',error=>deflate.destroy(error));
      source.pipe(measure).pipe(deflate);
      for await (const chunk of deflate) { compressed+=chunk.length; await write(chunk); }
      crc=(crc^0xffffffff)>>>0;
      const descriptor=Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc,4); descriptor.writeUInt32LE(compressed,8); descriptor.writeUInt32LE(size,12); await write(descriptor);
      const record=Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20,4); record.writeUInt16LE(20,6); record.writeUInt16LE(8,8); record.writeUInt16LE(8,10); record.writeUInt32LE(crc,16); record.writeUInt32LE(compressed,20); record.writeUInt32LE(declaredSize ?? size,24); record.writeUInt16LE(filename.length,28); record.writeUInt32LE(start,42);
      central.push(record,filename);
    }
    const start=position;
    for (const part of central) await write(part);
    const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(position-start,12); end.writeUInt32LE(start,16); await write(end);
  } finally { await file.close(); }
}
const baseParts = (sheet, options = {}) => [
  ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
  ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml',`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${options.date1904 ? 1:0}"/><sheets><sheet name="Журнал" sheetId="1" r:id="sheet"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${options.shared ? '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : ''}${options.styles ? '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ''}</Relationships>`],
  ['xl/worksheets/sheet1.xml',sheet,options.declaredSize],
  ...(options.shared ? [['xl/sharedStrings.xml',options.shared]] : []),
  ...(options.styles ? [['xl/styles.xml',options.styles]] : []),
];
async function xmlFixture(t, xml, options = {}) {
  const dir=await mkdtemp(join(tmpdir(),'journal-stream-xml-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'events.xlsx'); await zipFixture(path,baseParts(xml,options)); return {path,dir};
}

for (const shared of [false,true]) test(`stream C/F/J matches aggregation of SheetJS cells (${shared?'shared':'inline'} strings)`, async t => {
  const text=description+'\nСохранить & <> "точный" текст';
  const {path,bytes}=await fixture(t,{ 'Журнал':[['События за период'],headers,event('000123','06.03.2026 12:55:33',text),event('000123','06.03.2026 12:55:33',text),event(123,'07.03.2026',description),event('bad','31.02.2026',description),event(1234567890123456,'01.01.2026',description)], 'Пояснения':[['не журнал'],['private-unused']] },{shared,mutate:book=>{book.Sheets.Журнал.C5.z='000000';}});
  const actual=await readEventJournalXLSX(path), expected=readJournalWorkbook(bytes,XLSX,'events');
  assert.deepEqual(actual.groups,expected.groups); assert.deepEqual(actual.stats,expected.stats);
  assert.equal(actual.stats.accepted,3); assert.equal(actual.groups[0].count,3); assert.equal(actual.groups[0].examples[0].description,text);
  assert.ok(actual.warnings.some(value=>value.includes('Пояснения'))); assert.ok(!JSON.stringify(actual).includes('private-'));
});

test('rich shared strings, numeric zero padding, 1904 civil dates and compact header work together',async t=>{
  const shared='<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Серийный</t></si><si><t>Дата и время</t></si><si><t>Дополнительная информация</t></si><si><r><t>Вскрытый элемент устройства </t></r><r><t>&quot;Корпус&quot;_x000D_</t></r><rPh sb="0" eb="1"><t>IGNORE PHONETIC</t></rPh><r><t>Полное &amp; пояснение</t></r></si></sst>';
  const styles='<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>';
  const sheet=worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" s="1"><v>123</v></c><c r="B2"><v>1.5</v></c><c r="C2" t="s"><v>3</v></c></row>');
  const {path}=await xmlFixture(t,sheet,{shared,styles,date1904:true}); const pack=await readEventJournalXLSX(path);
  assert.equal(pack.groups[0].serial,'000123');assert.equal(pack.groups[0].first,'1904-01-02T12:00:00');assert.equal(pack.groups[0].examples[0].description,'Вскрытый элемент устройства "Корпус"\rПолное & пояснение');
});

for(const withHeader of [true,false])test(`strict three-column export ${withHeader?'with':'without'} header retains the first registration`,async t=>{
  const rows=[...(withHeader?[compactHeaders]:[]),['000123','01.08.2026',description],['000123','01.08.2026',description],['000123','bad date',description]];
  const {path}=await fixture(t,{Лист1:rows});const pack=await readEventJournalXLSX(path);
  assert.equal(pack.stats.rows,3);assert.equal(pack.stats.accepted,2);assert.equal(pack.stats.invalidDates,1);assert.equal(pack.groups[0].count,2);
});

test('compact schema rejects later fourth-column content instead of guessing the workbook layout',async t=>{
  const {path}=await fixture(t,{Лист1:[['000123','01.08.2026',description],['000123','02.08.2026',description,'unrelated data']]});
  await assert.rejects(readEventJournalXLSX(path),/трёхколоночного/);
});
test('optional row and cell references follow implicit OOXML column order',async t=>{
  const cells=values=>values.map(value=>`<c t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('');
  const {path}=await xmlFixture(t,worksheet(`<row>${cells(compactHeaders)}</row><row>${cells(['000123','01.08.2026',description])}</row>`));
  const pack=await readEventJournalXLSX(path);assert.equal(pack.stats.accepted,1);assert.equal(pack.groups[0].serial,'000123');
});
test('shifted full columns and a header after the first 80 source rows are rejected',async t=>{
  const moved=[...headers];[moved[2],moved[3]]=[moved[3],moved[2]];
  const first=await fixture(t,{Лист1:[moved,event('000123','01.08.2026')]});await assert.rejects(readEventJournalXLSX(first.path),/шапка/);
  const second=await fixture(t,{Лист1:[...Array.from({length:80},()=>['текст']),headers,event('000123','01.08.2026')]});await assert.rejects(readEventJournalXLSX(second.path),/шапка/);
});
test('empty, malformed XML, DTD, bad shared references and oversized parts fail explicitly',async t=>{
  const empty=await fixture(t,{Лист1:[headers]});await assert.rejects(readEventJournalXLSX(empty.path),/пригодных строк/);
  const malformed=await xmlFixture(t,'<worksheet><sheetData></worksheet>');await assert.rejects(readEventJournalXLSX(malformed.path));
  const dtd=await xmlFixture(t,'<!DOCTYPE worksheet [<!ENTITY x "custom">]>'+worksheet(''));await assert.rejects(readEventJournalXLSX(dtd.path),/DTD/);
  const invalid=await xmlFixture(t,worksheet('<row r="1"><c r="A1" t="s"><v>5</v></c></row>'),{shared:'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>one</t></si></sst>'});await assert.rejects(readEventJournalXLSX(invalid.path),/индекс/);
  const huge=await xmlFixture(t,worksheet(''),{declaredSize:1024*1048576+1});await assert.rejects(readEventJournalXLSX(huge.path),/безопасный размер/);
});

test('numeric civil timestamps match SheetJS across1900/1904 dates and time fractions',()=>{
  for(const date1904 of [false,true])for(const value of [0,1,59,60,61,1462,43831,46000.125,46000.9999999999,46000.1234567,109574,-1,NaN,Infinity])assert.equal(streamJournalTimestamp(value,date1904),parseJournalTimestamp(value,XLSX,date1904),`${value} date1904=${date1904}`);
});

async function child(path,output,filename,timeout=120000) {
  // Some CI/container runners expose host /proc IDs but namespace child PIDs.
  // Sample inside the child too. Linux maxRSS can include memory inherited
  // before exec and would exaggerate the live RSS seen by the server guard.
  const measure=join(dirname(output),'measure-memory.mjs');
  await writeFile(measure,"let peak=process.memoryUsage();const sample=()=>{const current=process.memoryUsage();if(current.rss>peak.rss)peak=current};const timer=setInterval(sample,10);timer.unref();process.once('exit',()=>{sample();process.stderr.write('QA_MEMORY='+JSON.stringify(peak)+'\\n')});\n");
  const flags=await preparationChildFlags(path,'events',filename,512);
  const proc=spawn(process.execPath,[...flags,'--import',measure,new URL('../prepare-child.mjs',import.meta.url).pathname,path,output,'events',filename],{stdio:['ignore','ignore','pipe']});
  let stderr='',peakRSS=0; proc.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-8192));
  const timer=setTimeout(()=>proc.kill('SIGKILL'),timeout),started=performance.now();
  try { const code=await new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',resolve);});assert.equal(code,0,stderr||'child failed');const memory=JSON.parse(stderr.match(/QA_MEMORY=(\{[^\n]+\})/)?.[1]||'{}');peakRSS=memory.rss/1024;assert.ok(peakRSS>0,'child peak live RSS must be measured');return{peakRSSMB:peakRSS/1024,memory,ms:performance.now()-started,pack:JSON.parse(await readFile(output,'utf8'))}; }
  finally {clearTimeout(timer);}
}
test('preparation child keeps legacy XLS support while routing XLSX46 through streaming',async t=>{
  for(const bookType of ['xlsx','biff8']){
    const {path,dir}=await fixture(t,{Лист1:[headers,event('000123','01.08.2026'),event('000123','01.08.2026')]},{bookType});
    assert.deepEqual(await preparationChildFlags(path,'events','46.xls',512),bookType==='xlsx'?['--max-old-space-size=64','--max-semi-space-size=4']:['--max-old-space-size=128']);
    assert.deepEqual(await preparationChildFlags(path,'instant','31.xlsx',512),['--max-old-space-size=128']);
    assert.deepEqual(await preparationChildFlags(path,'events','46.xlsb',512),['--max-old-space-size=128']);
    assert.deepEqual(await preparationChildFlags(path,'events','46.xlsx',1024),['--max-old-space-size=512']);
    const result=await child(path,join(dir,'pack.json'),bookType==='biff8'?'46.xls':'46.xlsx');assert.equal(result.pack.aggregationVersion,1);assert.equal(result.pack.stats.accepted,2);assert.equal(result.pack.groups[0].count,2);
  }
});

test('600000-row XLSX46 prepares within512MB server child budget without materializing worksheets',{skip:process.env.RUN_LARGE_JOURNAL_TEST!=='1',timeout:120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-stream-large-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'600k.xlsx');
  function* sheet(){
    yield Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rowXML(1,headers.map((value,index)=>[String.fromCharCode(65+index),value])));
    for(let block=0;block<600;block++){
      let xml='';for(let offset=0;offset<1000;offset++){
        const index=block*1000+offset,number=index+2,serial=String(index%1000).padStart(6,'0'),day=String(index%28+1).padStart(2,'0');
        xml+=rowXML(number,[['A','ignored source point'],['B','ignored model'],['C',serial],['D','ignored name'],['E','ignored limit'],['F',day+'.08.2026 12:00:00'],['G','ignored type'],['H','ignored event'],['I','ignored author'],['J',description]]);
      }yield Buffer.from(xml);
    }
    yield Buffer.from('</sheetData></worksheet>');
  }
  await zipFixture(path,baseParts(sheet()));
  const result=await child(path,join(dir,'pack.json'),'46.xlsx');
  t.diagnostic(JSON.stringify({rows:600000,groups:1000,peakRSSMB:result.peakRSSMB,memory:result.memory,preparationMS:Math.round(result.ms),packageBytes:JSON.stringify(result.pack).length}));
  assert.equal(result.pack.stats.accepted,600000);assert.equal(result.pack.stats.groups,1000);assert.equal(result.pack.stats.meters,1000);assert.ok(result.pack.groups.every(group=>group.count===600));assert.ok(!('rows'in result.pack));
  assert.ok(result.peakRSSMB<160,`512MB plan child RSSguard160MB, measured ${result.peakRSSMB.toFixed(1)}MB`);
  assert.ok(result.ms<120000);
});
