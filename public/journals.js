import { clean, norm, idKey } from './core.js';
import { numeric } from './monthly.js';

const MAX_ROWS = 500000, MAX_METERS = 100000;
const metric = (key, title, unit) => ({ key, title, unit });
export const INSTANT_METRICS = [
  metric('forwardMin','Мощность A+, минимум профиля','кВт'), metric('forwardAvg','Мощность A+, среднее профиля','кВт'), metric('forwardMax','Мощность A+, максимум профиля','кВт'),
  metric('reverseMin','Мощность A−, минимум профиля','кВт'), metric('reverseAvg','Мощность A−, среднее профиля','кВт'), metric('reverseMax','Мощность A−, максимум профиля','кВт'),
  metric('reactiveImportMin','Мощность R+, минимум профиля','кВАр'), metric('reactiveImportAvg','Мощность R+, среднее профиля','кВАр'), metric('reactiveImportMax','Мощность R+, максимум профиля','кВАр'),
  metric('reactiveExportMin','Мощность R−, минимум профиля','кВАр'), metric('reactiveExportAvg','Мощность R−, среднее профиля','кВАр'), metric('reactiveExportMax','Мощность R−, максимум профиля','кВАр'),
  metric('activeTotal','Активная мощность, сумма фаз','кВт'), ...[1,2,3].map(p => metric('active'+p,'Активная мощность, фаза '+p,'кВт')),
  metric('reactiveTotal','Реактивная мощность, сумма фаз','кВАр'), ...[1,2,3].map(p => metric('reactive'+p,'Реактивная мощность, фаза '+p,'кВАр')),
  metric('apparentTotal','Полная мощность, сумма фаз','кВА'), ...[1,2,3].map(p => metric('apparent'+p,'Полная мощность, фаза '+p,'кВА')),
  ...[1,2,3].map(p => metric('voltage'+p,'Напряжение, фаза '+p,'В')), ...[1,2,3].map(p => metric('current'+p,'Ток, фаза '+p,'А')),
  metric('neutralCurrent','Ток нулевого провода','А'), metric('powerFactorTotal','Общий коэффициент мощности',''),
  ...[1,2,3].map(p => metric('powerFactor'+p,'Коэффициент мощности, фаза '+p,'')), metric('frequency','Частота','Гц'),
  ...[1,2,3].map(p => metric('distortion'+p,'Искажение напряжения Ku, фаза '+p,'')),
  ...[1,2,3].map(p => metric('tangent'+p,'tg φ, фаза '+p,'')), ...[1,2,3].map(p => metric('angle'+p,'Угол U–I, фаза '+p,'°')),
  metric('temperature','Температура','°C'),
];
export const INSTANT_FIELDS = INSTANT_METRICS.map(m => m.key);
export const serialKey = value => idKey(value);
const pad = n => String(n).padStart(2,'0');
function civil(y,m,d,h=0,min=0,s=0) {
  if (![y,m,d,h,min,s].every(Number.isInteger) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || h < 0 || h > 23 || min < 0 || min > 59 || s < 0 || s > 59) return null;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0), days = [31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (d > days[m-1]) return null;
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}`;
}
// Source journals contain local civil time, without a zone. Keep it local:
// Date.parse / toISOString would move chart markers on some devices.
export function parseJournalTimestamp(value, XLSX = null, date1904 = false) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !XLSX?.SSF?.parse_date_code) return null;
    const p = XLSX.SSF.parse_date_code(value,{date1904});
    return p ? civil(p.y,p.m,p.d,p.H,p.M,Math.round(p.S)) : null;
  }
  const s = clean(value);
  let hit = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (hit) return civil(+hit[3],+hit[2],+hit[1],+(hit[4]||0),+(hit[5]||0),+(hit[6]||0));
  hit = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  return hit ? civil(+hit[1],+hit[2],+hit[3],+(hit[4]||0),+(hit[5]||0),+(hit[6]||0)) : null;
}

const EVENT_DEFS = [
  { rx:/магнит.*переменн/, code:'J46_MAGNET_AC', title:'Магнитная пломба переменного поля', kind:'magnetic' },
  { rx:/магнит.*постоянн/, code:'J46_MAGNET_DC', title:'Магнитная пломба постоянного поля', kind:'magnetic' },
  { rx:/клеммн.*крышк/, code:'J46_TERMINAL_COVER', title:'Вскрытие клеммной крышки', kind:'opening' },
  { rx:/клеммн.*колодк/, code:'J46_TERMINAL_BLOCK', title:'Вскрытие клеммной колодки', kind:'opening' },
  { rx:/электронн.*пломб/, code:'J46_ELECTRONIC_SEAL', title:'Электронная пломба', kind:'opening' },
  { rx:/корпус/, code:'J46_CASE', title:'Вскрытие корпуса', kind:'opening' },
  { rx:/магнит/, code:'J46_MAGNETIC', title:'Событие магнитного воздействия', kind:'magnetic' },
];
function kindsForClause(description) {
  const s = norm(description);
  if (!s || /(?:не\s+(?:вскрыт|открыт|обнаружен|зафиксирован)|нет\s+(?:магнит|воздейств)|отсутств(?:ует|ие)|снят(?:ие)?\s+магнит|закрыт|закрытие|восстановлен|сброс.*(?:магнит|пломб))/.test(s)) return [];
  const opening=/(?:вскрыт|открыт)/.test(s);
  const magneticActivation=/магнит/.test(s)&&/(?:обнаруж|зафиксир|сработ|зарегистрир|активир)/.test(s);
  if (!opening && !magneticActivation) return [];
  const defs = EVENT_DEFS.filter(d => d.rx.test(s) && (d.kind!=='opening'||opening));
  // AC/DC already identify a magnetic category; the generic magnetic event
  // must not count the same activation a second time.
  const specificMagnet=defs.some(d=>d.code==='J46_MAGNET_AC'||d.code==='J46_MAGNET_DC');
  return defs.filter(d=>d.code!=='J46_MAGNETIC'||!specificMagnet).map(def=>({ code:def.code,title:def.title,kind:def.kind,recommendation:def.kind==='magnetic'
    ? 'Проверить пломбы и журнал работ; сопоставить событие с изменением потребления, подтвердить воздействие инструментальной проверкой.'
    : 'Проверить журнал плановых работ, пломбы и схему подключения; сопоставить дату события с потреблением.' }));
}
export function eventKinds(description) {
  // A J cell may describe both restoration and an independent opening.
  // Evaluate explicit clauses separately, without changing the original J.
  const clauses=String(description??'').replace(/<br\s*\/?>/gi,'\n').split(/[\r\n;]+/);
  const kinds=new Map();
  for(const clause of clauses)for(const kind of kindsForClause(clause))if(!kinds.has(kind.code))kinds.set(kind.code,kind);
  return [...kinds.values()];
}
export function eventKind(description) {
  return eventKinds(description)[0]??null;
}

// Column encoding is delegated to SheetJS so sparse XLS and dense XLSX work alike.
const valueCell = (ws,r,c,XLSX) => c<0 ? undefined : ws['!data'] ? ws['!data'][r]?.[c] : ws[XLSX.utils.encode_cell({r,c})];
const serialHeader = value => /^(серийный(?: номер)?|номер пу|заводской номер(?: пу| счетчика)?|номер счетчика)$/.test(norm(value));
function identifier(cell) {
  const v = cell?.v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || Math.abs(v) >= 1e15 || v < 0) return '';
    return /^0+$/.test(cell.z||'') ? String(v).padStart(cell.z.length,'0') : String(v);
  }
  return clean(v);
}
function serialFromPoint(point) {
  // A full location path may contain cadastral numbers and the model number.
  // Only an explicit final meter-number token identifies the meter.
  const tail = clean(point).split('\\').at(-1), hits = [...tail.matchAll(/№/g)];
  if (hits.length !== 1) return '';
  const hit = tail.match(/№\s*([\p{L}\p{N}][\p{L}\p{N}\s_.-]*)$/u);
  return hit ? clean(hit[1]) : '';
}
function periodFromHeader(rows) {
  for (const row of rows) {
    const text = row.map(clean).join(' '), hit = text.match(/(?:^|\s)с\s+(\d{1,2}\.\d{1,2}\.\d{4})\s+по\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (hit) {
      const from=parseJournalTimestamp(hit[1]),to=parseJournalTimestamp(hit[2]);
      if (from && to && from<=to) return {from:from.slice(0,10),to:to.slice(0,10)};
    }
  }
  return null;
}
const fmt = n => Number.isFinite(n) ? Number(n.toFixed(3)).toLocaleString('ru-RU') : 'нет данных';
const signal = (code,title,detail,recommendation,informational=false) => ({code,title,detail,recommendation,...(informational?{informational:true}:{})});
function detectSignals(v) {
  const out = [], phase = suffix => [1,2,3].map(p=>v[suffix+p]), u=phase('voltage'), i=phase('current'), p=phase('active'), s=phase('apparent'), pf=phase('powerFactor');
  const recommendations = 'Проверить схему подключения и полярность, коэффициенты трансформации и синхронность показаний; выполнить инструментальную проверку.';
  for (let k=0;k<3;k++) {
    if (p[k]!=null && p[k]<=-0.1 && (i[k]>=0.5 || s[k]>=0.1)) out.push(signal('J31_REVERSE','Обратное направление активной мощности',`Фаза ${k+1}: P=${fmt(p[k])} кВт, I=${fmt(i[k])} А.`, 'Проверить разрешённую генерацию, схему подключения и полярность трансформаторов тока.'));
    // Missing phases of a one-phase meter are not a fault. Require current in
    // the affected phase, or two other energized phases with one under load.
    if (u[k]!=null && u[k]<50 && (i[k]>=0.5 || u.filter((_,j)=>j!==k).every(x=>x!=null&&x>=180) && i.some((x,j)=>j!==k&&x>=0.5))) out.push(signal('J31_PHASE','Низкое напряжение отдельной фазы при нагрузке',`Фаза ${k+1}: U=${fmt(u[k])} В, I=${fmt(i[k])} А.`, 'Проверить питание, предохранители и цепь напряжения; уточнить фазность ПУ и наличие планового отключения.'));
    if (pf[k]!=null && Math.abs(pf[k])<0.2 && u[k]>=180 && i[k]>=0.5) out.push(signal('J31_PF','Низкий коэффициент мощности при нагрузке',`Фаза ${k+1}: |cos φ|=${fmt(Math.abs(pf[k]))}, U=${fmt(u[k])} В, I=${fmt(i[k])} А.`, 'Проверить характер реактивной нагрузки, фазировку токовых цепей и углы U–I. Сам по себе низкий cos φ не подтверждает недоучёт.',true));
    const load = s[k]>=0.2 || u[k]>=180 && i[k]>=1;
    if (p[k]!=null && Math.abs(p[k])<0.01 && load && pf[k]!=null && Math.abs(pf[k])>=0.5) out.push(signal('J31_POWER','Активная мощность не согласуется с нагрузкой',`Фаза ${k+1}: P=${fmt(p[k])} кВт, S=${fmt(s[k])} кВА, I=${fmt(i[k])} А, |cos φ|=${fmt(Math.abs(pf[k]))}.`, recommendations));
  }
  // The neutral RMS current can exceed each phase separately (harmonics).
  // Only exceedance of the SUM is a consistency warning, with a 20% margin.
  if (v.neutralCurrent!=null && i.every(x=>x!=null&&x>=0)) {
    const sum=i.reduce((a,b)=>a+b,0);
    if (v.neutralCurrent>=1 && v.neutralCurrent>sum*1.2 && v.neutralCurrent-sum>=0.5) out.push(signal('J31_NEUTRAL','Ток нейтрали превышает сумму фазных токов',`Iн=${fmt(v.neutralCurrent)} А; сумма фазных токов=${fmt(sum)} А.`, 'Проверить схему измерения нейтрали, датчики тока и синхронность значений. Это несогласованность измерений, а не доказательство вмешательства.'));
  }
  if (u.every(x=>x!=null&&x>=180) && i.every(x=>x!=null&&x>=0)) {
    const max=Math.max(...i),min=Math.min(...i);
    if (max>=1 && max>=Math.max(0.05,min)*5) out.push(signal('J31_UNBALANCE','Значительная неравномерность фазных токов',`I1=${fmt(i[0])}, I2=${fmt(i[1])}, I3=${fmt(i[2])} А; все три фазных напряжения присутствуют.`, 'Оценить распределение однофазных нагрузок. Перекос токов сам по себе не является признаком недоучёта.',true));
  }
  return out;
}
function extendDates(target,at) {
  if (!at) return;
  if (!target.first || at<target.first) target.first=at;
  if (!target.last || at>target.last) target.last=at;
}
function aggregateSignals(meter,signals,at) {
  // Count one signal once per row even if two or three phases are affected.
  const byCode=new Map();
  for (const hit of signals) {
    const old=byCode.get(hit.code);
    if (old) old.detail += ' '+hit.detail; else byCode.set(hit.code,{...hit});
  }
  for (const hit of byCode.values()) {
    let current=meter._signals.get(hit.code);
    if (!current) {current={...hit,count:0,first:null,last:null,_months:new Map()}; meter._signals.set(hit.code,current);}
    current.count++; extendDates(current,at);
    if (at) {
      const key=at.slice(0,7); let month=current._months.get(key);
      if (!month) {month={month:key,count:0,first:null,last:null,detail:hit.detail};current._months.set(key,month);}
      month.count++; extendDates(month,at);
    }
  }
}
function worksheetRows(ws,XLSX) {
  const range=XLSX.utils.decode_range(ws['!ref']);
  if (range.e.c>255) throw new Error('В журнале больше 256 столбцов.');
  if (ws['!fullref']) throw new Error('В журнале больше 500 000 строк данных. Разделите выгрузку по периодам.');
  return {range,rowAt:r=>Array.from({length:range.e.c+1},(_,c)=>valueCell(ws,r,c,XLSX)?.v??'')};
}
function instantColumns(header) {
  const cols=new Map(), h=header.map(norm);
  for(let c=0;c<h.length;c++) {
    const text=h[c], ph=Number(text.match(/(?:фаз[аеуы]?\s*|фаза\s*)([123])/)?.[1]);
    let key=null;
    if (/из профиля/.test(text)) {
      const suffix=/минимальн|(?:^|\s)мин(?:\s|$)/.test(text)?'Min':/средн/.test(text)?'Avg':/максимальн|(?:^|\s)макс(?:\s|$)/.test(text)?'Max':null;
      if (suffix) {
        if (/a\s*\+|а\s*\+/.test(text)) key='forward'+suffix;
        else if (/a\s*[-−]|а\s*[-−]/.test(text)) key='reverse'+suffix;
        else if (/r\s*\+|р\s*\+/.test(text)) key='reactiveImport'+suffix;
        else if (/r\s*[-−]|р\s*[-−]/.test(text)) key='reactiveExport'+suffix;
      }
    } else if (/\(r\s*[+−-]\)|\(р\s*[+−-]\)/.test(text)) {
      const suffix=/мин/.test(text)?'Min':/средн/.test(text)?'Avg':/макс/.test(text)?'Max':null;
      if (suffix) key=(/[+]/.test(text)?'reactiveImport':'reactiveExport')+suffix;
    } else if (/^активная мощность/.test(text)) key='active'+(ph||'Total');
    else if (/^реактивная мощность/.test(text)) key='reactive'+(ph||'Total');
    else if (/^полная мощность/.test(text)) key='apparent'+(ph||'Total');
    else if (/^напряжение на фазе/.test(text) && ph) key='voltage'+ph;
    else if (/^ток в фазе/.test(text) && ph) key='current'+ph;
    else if (/ток в нулевом|ток нейтрал/.test(text)) key='neutralCurrent';
    else if (/^общий коэффициент мощности/.test(text)) key='powerFactorTotal';
    else if (/^коэффициент мощности по фазе/.test(text) && ph) key='powerFactor'+ph;
    else if (/^частота/.test(text)) key='frequency';
    else if (/искажения.*напряжения/.test(text) && ph) key='distortion'+ph;
    else if (/^коэффициент реактивной мощности/.test(text) && ph) key='tangent'+ph;
    else if (/^угол между векторами/.test(text)) {const p=text.match(/фазы?\s*([abcабвс])/i)?.[1];const n={a:1,'а':1,b:2,'б':2,'в':2,c:3,'с':3}[p];if(n)key='angle'+n;}
    else if (/^температура/.test(text)) key='temperature';
    if(key && !cols.has(key)) cols.set(key,c);
  }
  return cols;
}

export function readJournalWorkbook(buffer,XLSX,role) {
  if (!['instant','events'].includes(role)) throw new Error('Неизвестная роль журнала.');
  const bytes=new Uint8Array(buffer),valid=[0xd0,0xcf,0x11,0xe0].every((v,i)=>bytes[i]===v)||bytes[0]===0x50&&bytes[1]===0x4b||bytes[0]===9&&[0,2,4,8].includes(bytes[1]);
  if (!valid) throw new Error('Выберите журнал Excel в формате XLS или XLSX.');
  const book=XLSX.read(buffer,{type:'array',dense:true,cellHTML:false,cellNF:true,cellText:false,cellFormula:false,sheetRows:MAX_ROWS+82});
  const stats={rows:0,accepted:0,skipped:0,duplicates:0,invalidDates:0,invalidSerials:0,emptyMetrics:0},warnings=[];
  const meters=new Map(),eventRows=[],eventSeen=new Map();let recognized=0,reportPeriod=null,coefficientMode='unknown';
  const date1904=!!book.Workbook?.WBProps?.date1904;
  for (const name of book.SheetNames) {
    const ws=book.Sheets[name]; if (!ws?.['!ref']) continue;
    const {range,rowAt}=worksheetRows(ws,XLSX);let h=-1,top=[];
    for(let r=0;r<=Math.min(range.e.r,79);r++) {
      const row=rowAt(r);top.push(row);
      if (role==='events' ? norm(row[2])==='серийный'&&norm(row[5])==='дата и время'&&norm(row[9])==='дополнительная информация'
        : (row.some(v=>/^(точка учета|ту)$/.test(norm(v)))||row.some(serialHeader))&&row.some(v=>/^(время|дата и время)$/.test(norm(v)))&&row.some(v=>/^активная мощность/.test(norm(v)))) {h=r;break;}
    }
    if(h<0) {warnings.push(`Лист «${name}» пропущен: не найдена шапка журнала ${role==='instant'?'31':'46'}.`);delete book.Sheets[name];continue;}
    recognized++;
    if(range.e.r-h>MAX_ROWS || stats.rows+range.e.r-h>MAX_ROWS) throw new Error('В журнале больше 500 000 строк данных. Разделите выгрузку по периодам.');
    const cols=role==='instant'?instantColumns(top[h]):null;
    if(role==='instant') {
      const basic=['active1','active2','active3','voltage1','voltage2','voltage3','current1','current2','current3','neutralCurrent','powerFactor1','powerFactor2','powerFactor3'];
      const missing=basic.filter(key=>!cols.has(key));
      if(missing.length) warnings.push(`Лист «${name}»: не представлены столбцы ${missing.map(key=>INSTANT_METRICS.find(m=>m.key===key).title).join('; ')}. Оценка ограничена имеющимися параметрами; отсутствие столбца не означает нулевое значение.`);
    }
    const pointCol=role==='instant'?top[h].findIndex(v=>/^(точка учета|ту)$/.test(norm(v))):-1;
    const serialCol=role==='instant'?top[h].findIndex(serialHeader):2;
    const timeCol=role==='instant'?top[h].findIndex(v=>/^(время|дата и время)$/.test(norm(v))):5;
    if(role==='instant') {
      const period=periodFromHeader(top.slice(0,h));
      if(period && !reportPeriod) reportPeriod=period;
      else if(period && JSON.stringify(period)!==JSON.stringify(reportPeriod)) throw new Error('Листы журнала 31 содержат разные периоды. Разделите выгрузку по периодам.');
      if(top.slice(0,h).some(row=>/без учета коэффициентов трансформации/.test(norm(row.join(' '))))) coefficientMode='unscaled';
    }
    for(let r=h+1;r<=range.e.r;r++) {
      const serialCell=serialCol>=0?valueCell(ws,r,serialCol,XLSX):null,pointCell=pointCol>=0?valueCell(ws,r,pointCol,XLSX):null;
      const rawSerial=serialCol>=0?identifier(serialCell):serialFromPoint(pointCell?.v);
      const rawTime=valueCell(ws,r,timeCol,XLSX)?.v,rawInfo=role==='events'?valueCell(ws,r,9,XLSX)?.v:null;
      const values=role==='instant'?INSTANT_FIELDS.map(key=>numeric(valueCell(ws,r,cols.get(key)??-1,XLSX)?.v)):null;
      if(!clean(serialCell?.v??pointCell?.v) && !clean(rawTime) && !clean(rawInfo) && (!values||values.every(v=>v==null))) continue;
      stats.rows++;
      if(!rawSerial || !serialKey(rawSerial)) {stats.invalidSerials++;stats.skipped++;continue;}
      const serial=serialKey(rawSerial),at=parseJournalTimestamp(rawTime,XLSX,date1904);
      if(!at) stats.invalidDates++;
      if(role==='events') {
        const details=String(rawInfo??'');
        if(!at || !details.trim()) {stats.skipped++;continue;}
        let dates=eventSeen.get(serial);
        if(!dates) {if(eventSeen.size>=MAX_METERS)throw new Error('В журнале больше 100 000 уникальных ПУ. Разделите выгрузку.');dates=new Map();eventSeen.set(serial,dates);}
        let detailsSet=dates.get(at);if(!detailsSet){detailsSet=new Set();dates.set(at,detailsSet);}
        if(detailsSet.has(details)){stats.duplicates++;continue;}
        detailsSet.add(details);eventRows.push([rawSerial,at,details]);stats.accepted++;
      } else {
        if(values.every(v=>v==null)){stats.emptyMetrics++;stats.skipped++;continue;}
        let meter=meters.get(serial);
        if(!meter) {if(meters.size>=MAX_METERS)throw new Error('В журнале больше 100 000 уникальных ПУ. Разделите выгрузку.');meter={serial:rawSerial,samples:0,datedSamples:0,first:null,last:null,latest:null,_signals:new Map()};meters.set(serial,meter);}
        meter.samples++;if(at)meter.datedSamples++;extendDates(meter,at);
        if(!meter.latest || at && (!meter.latest.at || at>=meter.latest.at) || !at && !meter.latest.at) meter.latest={at,values};
        const v=Object.fromEntries(INSTANT_FIELDS.map((key,j)=>[key,values[j]]));aggregateSignals(meter,detectSignals(v),at);stats.accepted++;
      }
    }
    delete book.Sheets[name];
  }
  if(!recognized)throw new Error(`Не найдена шапка журнала ${role==='instant'?'31':'46'}.`);
  if(!stats.accepted)throw new Error(`Журнал ${role==='instant'?'31':'46'} не содержит пригодных строк. Проверьте серийные номера, даты и значения.`);
  if(stats.invalidSerials)warnings.push(`Не удалось надёжно определить серийный номер: ${stats.invalidSerials} строк. Числовые номера длиннее 15 цифр и строки без явного № не сопоставлены.`);
  if(stats.invalidDates)warnings.push(role==='events'?`События с пустой или неверной датой пропущены: ${stats.invalidDates}.`:`Измерения без корректного времени: ${stats.invalidDates}; они не привязаны к месяцам графика.`);
  if(stats.emptyMetrics)warnings.push(`Измерения без числовых параметров пропущены: ${stats.emptyMetrics}.`);
  if(stats.duplicates)warnings.push(`Повторные события C/F/J исключены: ${stats.duplicates}.`);
  if(role==='events')return {format:1,role,rows:eventRows,stats,warnings};
  if(coefficientMode==='unscaled')warnings.push('Журнал 31 сформирован без коэффициентов трансформации. Мощность не сравнивается напрямую с объёмом потребления.');
  const output=[...meters.values()].map(({_signals,...meter})=>({...meter,signals:[..._signals.values()].map(({_months,...s})=>({...s,months:[..._months.values()].sort((a,b)=>a.month.localeCompare(b.month))}))}));
  return {format:1,role,reportPeriod,coefficientMode,fields:[...INSTANT_FIELDS],meters:output,stats:{...stats,meters:output.length},warnings};
}
