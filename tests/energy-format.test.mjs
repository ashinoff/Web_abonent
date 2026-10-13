import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEnergy, formatEnergyText, isEnergyLabel, observeReadingEnergy } from '../public/energy-format.js';
import { Window } from 'happy-dom';
import { groupRecordFields } from '../public/record-sections.js';
import { calculateReading } from '../public/readings.js';
import { flagObservation } from '../public/analysis-observations.js';
import { journalReportSheet } from '../public/journal-report-data.js';

const plain = text => text.replace(/[\u00a0\u202f]/g, ' ');
test('energy display rounds to whole kWh with symmetric negatives, real zeros and missing values', () => {
  for (const [value, expected] of [[1241.45,'1 241'],[1241.5,'1 242'],[-1241.5,'-1 242'],[-.49,'0'],[0,'0'],[.5,'1'],[-.5,'-1'],[null,'—'],[NaN,'—'],[Infinity,'—'],['1 241,7','1 242']]) assert.equal(plain(formatEnergy(value)),expected);
});
test('only numbers carrying energy units are rounded in factual descriptions', () => {
  const source = 'ПУ 0000123; 2026-04: ПО 1\u00a0241,75 кВт·ч. База 800,6 кВтч; падение 27,3%. P=-0,35 кВт; I=2,75 А; U=230,5 В; cos φ=0,85; № 12. Коэффициент 1,5. 12.04.2026';
  assert.equal(plain(formatEnergyText(source)), 'ПУ 0000123; 2026-04: ПО 1 242 кВт·ч. База 801 кВтч; падение 27,3%. P=-0,35 кВт; I=2,75 А; U=230,5 В; cos φ=0,85; № 12. Коэффициент 1,5. 12.04.2026');
  assert.equal(formatEnergyText('ПО −1,5 kWh; корректировка -0,2 кВт·ч'), 'ПО -2 kWh; корректировка 0 кВт·ч');
  assert.equal(formatEnergyText('Замер 0,35 кВАр, S=0,75 кВА и угол 12,5°'), 'Замер 0,35 кВАр, S=0,75 кВА и угол 12,5°');
});
test('registry card hides just the Excel ordinal and formats energy while preserving IDs, power and source cells', () => {
  const labels=['Основные реквизиты · № п/п','ЛС / ЛС СТЕК','Номер ТУ','Номер счетчика','Рассчитанные величины · Итоговый ПО','Объём электроэнергии','Максимальная мощность','События · Показания с квитанции показания','Расход газа, м³'];
  const values=['33,801','0000123','0000042','0000999','1 241,75','-12,8','15,25','128,75','2,6'];
  const before=structuredClone(values), fields=groupRecordFields(labels,values).flatMap(g=>g.fields).sort((a,b)=>a.index-b.index);
  assert.deepEqual(fields.map(f=>f.index),[1,2,3,4,5,6,7,8]);
  assert.deepEqual(fields.map(f=>plain(f.value)),['0000123','0000042','0000999','1 242','-13','15,25','128,75','2,6']);
  assert.deepEqual(values,before); assert.equal(isEnergyLabel('Активная мощность, кВт'),false);
});
test('rounding the reading display preserves its exact difference and transformer coefficient', () => {
  const result=calculateReading('128,75','100,25','1,5');
  assert.equal(result.volume,42.75); assert.equal(formatEnergy(result.volume),'43'); assert.equal(result.actual,128.75); assert.equal(result.ratio,1.5);
});
test('calculator display formatting preserves inputs and formulas, works after replacing cards and stops at a stable value', async () => {
  const window = new Window(), host = window.document.createElement('div');
  window.document.body.append(host); const observer = observeReadingEnergy(host);
  for (const value of ['42,75 кВт·ч', '-0,2 кВт·ч']) {
    host.innerHTML = '<div class="reading-calculator"><input value="128,75"><output></output></div><p class="reading-formula">(128,75 − 100,25) × 1,5</p>';
    host.querySelector('output').textContent = value;
    await window.happyDOM.whenAsyncComplete();
    assert.equal(host.querySelector('output').textContent, value.startsWith('-') ? '0 кВт·ч' : '43 кВт·ч');
    assert.equal(host.querySelector('input').value, '128,75'); assert.equal(host.querySelector('.reading-formula').textContent, '(128,75 − 100,25) × 1,5');
  }
  host.innerHTML = '<div class="reading-calculator" data-calculated="true" data-previous="0" data-ratio="1"><input value="25,4999995"><output>25,5 кВт·ч</output></div>';
  host.querySelector('output').textContent = '25,5 кВт·ч';
  await window.happyDOM.whenAsyncComplete();
  assert.equal(host.querySelector('output').textContent, '25 кВт·ч');
  assert.equal(host.querySelector('input').value, '25,4999995');
  observer.disconnect();
});
test('both report reasons and journal comparisons use whole volumes and retain fractional percentages and electrical measurements', () => {
  const flag={code:'S10',detail:'Расход ~12,75 кВт·ч/мес. Проверить ввод.'};
  assert.equal(flagObservation(flag),'Расход ~13 кВт·ч/мес'); assert.equal(flag.detail,'Расход ~12,75 кВт·ч/мес. Проверить ввод.');
  const report={coverage:{instant:{loaded:true}},rows:[{serial:'0000123',instantFlags:[{title:'Обратная мощность',detail:'P=-0,35 кВт, I=2,75 А',count:1}],eventFlags:[],instantPresent:true,
    consumption:{account:'0000001',point:'ТУ 1',cls:'green',flags:[{source:'correlation',title:'Снижение',comparison:{months:['2026-04'],month:'2026-04',value:12.75,comparisons:{previous:{available:true,value:123.75,dropPercent:89.7}},temporalRelation:'same_month'}}]}}]};
  const cells=journalReportSheet(report).rows.at(0).cells;
  assert.match(cells[2],/P=-0,35 кВт, I=2,75 А/); assert.match(cells[3],/ПО 13 кВт·ч/); assert.match(cells[3],/Предыдущий месяц: 124 кВт·ч; снижение 89,7%/);
});
