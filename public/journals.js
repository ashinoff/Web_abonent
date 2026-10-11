import { clean, norm, idKey } from './core.js';
import { numeric } from './monthly.js';

export const JOURNAL_ANALYSIS_VERSION = 2;
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
const signal = (code,title,detail,recommendation,informational=false,conditional=false) => ({code,title,detail,recommendation,...(informational?{informational:true}:{}),...(conditional?{conditional:true}:{})});
const finite = value => typeof value==='number'&&Number.isFinite(value);
const nonnegative = value => finite(value)&&value>=0;
const sufficientlyDifferent = (a,b,relative=0.35,absolute=0.15) => Math.abs(a-b)>absolute&&Math.abs(a-b)>Math.max(Math.abs(a),Math.abs(b))*relative;
function detectSignals(v,{compareUI=false,knownUnits=new Set(),displacementFactors=new Set()}={}) {
  const out = [], phase = suffix => [1,2,3].map(p=>v[suffix+p]), u=phase('voltage'), i=phase('current'), p=phase('active'), q=phase('reactive'), s=phase('apparent'), pf=phase('powerFactor'), angles=phase('angle');
  const recommendations = 'Проверить схему подключения и полярность, коэффициенты трансформации и синхронность показаний; выполнить инструментальную проверку. Уточнить определение cos φ/полного PF и гармонический состав нагрузки.';
  // These are screening tolerances, not meter accuracy classes or legal
  // thresholds. S=P/PF applies to true PF, not necessarily exported cos φ.
  // Primary documentation: productinfo.se.com/pm5500 (PowerFactorPF),
  // productinfo.se.com/micrologicxuserguide (Power factor), se.com/FA212226.
  for (let k=0;k<3;k++) {
    const ph=k+1;
    if (finite(p[k])&&p[k]<=-0.1&&(finite(i[k])&&i[k]>=0.5||finite(s[k])&&s[k]>=0.1)) out.push({...signal('J31_REVERSE','Обратное направление активной мощности',`Фаза ${ph}: P=${fmt(p[k])} кВт, I=${fmt(i[k])} А.`, 'Проверить разрешённую генерацию, схему подключения и полярность трансформаторов тока.'),family:'direction'});
    // A one-phase meter's two absent channels are not missing phases.
    if (nonnegative(u[k])&&u[k]<50&&(finite(i[k])&&i[k]>=0.5||u.filter((_,j)=>j!==k).every(x=>finite(x)&&x>=180)&&i.some((x,j)=>j!==k&&finite(x)&&x>=0.5))) out.push(signal('J31_PHASE','Низкое напряжение отдельной фазы при нагрузке',`Фаза ${ph}: U=${fmt(u[k])} В, I=${fmt(i[k])} А.`, 'Проверить питание, предохранители и цепь напряжения; уточнить фазность ПУ и наличие планового отключения.'));
    if (u.every(x=>finite(x)&&x>=180)&&nonnegative(i[k])&&i[k]<=0.02&&i.some((x,j)=>j!==k&&finite(x)&&x>=1)) out.push(signal('J31_MISSING_CURRENT','Практически отсутствует ток одной фазы при наличии напряжения',`Фаза ${ph}: U=${fmt(u[k])} В, I=${fmt(i[k])} А; токи фаз ${i.map(fmt).join(' / ')} А.`, 'Проверить, подключена ли нагрузка этой фазы, и токовую цепь. Нулевая нагрузка допустима; наблюдение учитывается только вместе с независимым событием вскрытия и падением потребления.',true,true));
    if (finite(pf[k])&&Math.abs(pf[k])<0.2&&finite(u[k])&&u[k]>=180&&finite(i[k])&&i[k]>=0.5) out.push(signal('J31_PF','Низкий коэффициент мощности при нагрузке',`Фаза ${ph}: |cos φ|=${fmt(Math.abs(pf[k]))}, U=${fmt(u[k])} В, I=${fmt(i[k])} А.`, 'Проверить характер реактивной нагрузки, фазировку токовых цепей и углы U–I. Сам по себе низкий cos φ не подтверждает недоучёт.',true));
    const load=finite(s[k])&&s[k]>=0.2||finite(u[k])&&u[k]>=180&&finite(i[k])&&i[k]>=1;
    if (finite(p[k])&&Math.abs(p[k])<0.01&&load&&finite(pf[k])&&Math.abs(pf[k])>=0.5&&Math.abs(pf[k])<=1) out.push(signal('J31_POWER','Активная мощность не согласуется с нагрузкой',`Фаза ${ph}: P=${fmt(p[k])} кВт, S=${fmt(s[k])} кВА, I=${fmt(i[k])} А, |cos φ|=${fmt(Math.abs(pf[k]))}.`, recommendations));
    // The universal bound is |P| <= S. Distortion can make S GREATER
    // than sqrt(P²+Q²); this direction must never be treated as a fault.
    if (nonnegative(s[k])&&s[k]>=0.2) {
      if(finite(p[k])&&Math.abs(p[k])>s[k]&&sufficientlyDifferent(Math.abs(p[k]),s[k])) out.push(signal('J31_VECTOR','Несогласованность фазных P/Q/S',`Фаза ${ph}: |P|=${fmt(Math.abs(p[k]))} кВт превышает S=${fmt(s[k])} кВА с большим запасом.`,recommendations));
      else if(finite(p[k])&&finite(q[k])) {
        const pq=Math.hypot(p[k],q[k]);
        if(pq>s[k]&&sufficientlyDifferent(pq,s[k]))out.push(signal('J31_VECTOR','Несогласованность фазных P/Q/S',`Фаза ${ph}: P=${fmt(p[k])} кВт, Q=${fmt(q[k])} кВАр; √(P²+Q²)=${fmt(pq)} кВА, S=${fmt(s[k])} кВА.`,recommendations));
      }
    }
    // CT/VT-scaled power and raw secondary U/I are not directly comparable.
    // Only check S versus U*I when this sheet explicitly says unscaled and
    // all three physical units were recognised and normalised.
    const ui=nonnegative(u[k])&&nonnegative(i[k])?u[k]*i[k]/1000:null;
    if(compareUI&&['voltage'+ph,'current'+ph,'apparent'+ph].every(key=>knownUnits.has(key))&&finite(ui)&&nonnegative(s[k])&&Math.max(ui,s[k])>=0.5&&sufficientlyDifferent(ui,s[k],0.4,0.2)) out.push(signal('J31_VECTOR_UI','Полная мощность не согласуется с U × I',`Фаза ${ph}: U=${fmt(u[k])} В, I=${fmt(i[k])} А; U×I/1000=${fmt(ui)} кВА, S=${fmt(s[k])} кВА. Отчёт без коэффициентов трансформации.`, 'Проверить, относятся ли U, I и S к одной стороне трансформаторов и одному моменту, единицы и определения полной мощности. Это условное наблюдение, а не расчёт недоучёта.',true,true));
    const vectorLoad=finite(s[k])&&s[k]>=0.5||compareUI&&finite(ui)&&ui>=0.5;
    if(finite(angles[k])&&Math.abs(angles[k])<=360&&knownUnits.has('angle'+ph)&&vectorLoad) {
      // Sign conventions differ across models. Compare absolute cosine and
      // the acute U-I angle, not the sign of PF or inductive/capacitive Q.
      const cosine=Math.abs(Math.cos(angles[k]*Math.PI/180));
      if(displacementFactors.has('powerFactor'+ph)&&finite(pf[k])&&Math.abs(pf[k])<=1&&Math.abs(cosine-Math.abs(pf[k]))>0.35) out.push(signal('J31_VECTOR_ANGLE','Несогласованность угла U–I и фазных коэффициентов',`Фаза ${ph}: угол U–I=${fmt(angles[k])}°, |cos(угла)|=${fmt(cosine)}, |cos φ|=${fmt(Math.abs(pf[k]))}.`, 'Проверить соглашение об углах и знаках, фазировку и синхронность измерений. cos φ основной гармоники отличается от полного PF при несинусоидальной нагрузке.',true,true));
      // Unknown current THD is not ruled out by voltage Ku. Do not compare
      // Q/P with a fundamental angle when exported DPF and true |P|/S
      // already diverge appreciably, as they can under harmonics.
      const fundamentalComparable=displacementFactors.has('powerFactor'+ph)&&finite(pf[k])&&Math.abs(pf[k])<=1&&finite(p[k])&&finite(s[k])&&s[k]>=0.5&&Math.abs(Math.abs(p[k])/s[k]-Math.abs(pf[k]))<0.15;
      if(fundamentalComparable&&finite(q[k])&&Math.hypot(p[k],q[k])>=0.5) {
        const pqAngle=Math.atan2(Math.abs(q[k]),Math.abs(p[k]))*180/Math.PI,uiAngle=Math.acos(Math.min(1,cosine))*180/Math.PI;
        if(Math.abs(pqAngle-uiAngle)>35) out.push(signal('J31_VECTOR_ANGLE','Несогласованность угла U–I и фазных коэффициентов',`Фаза ${ph}: P=${fmt(p[k])} кВт, Q=${fmt(q[k])} кВАр; угол по |Q/P|=${fmt(pqAngle)}°, приведённый угол U–I=${fmt(uiAngle)}° (исходный ${fmt(angles[k])}°).`, 'Проверить гармоники, способ расчёта реактивной мощности, соглашение об углах и синхронность измерений. Условное наблюдение требует независимого события вскрытия и падения потребления.',true,true));
      }
    }
  }
  // Neutral RMS can exceed any SINGLE phase through triplen harmonics.
  // Only exceeding their SUM indicates inconsistent simultaneous readings;
  // even this does not identify a jumper or prove unauthorised consumption.
  if(nonnegative(v.neutralCurrent)&&i.every(nonnegative)) {
    const sum=i.reduce((a,b)=>a+b,0);
    if(v.neutralCurrent>=1&&v.neutralCurrent>sum*1.2&&v.neutralCurrent-sum>=0.5) out.push(signal('J31_NEUTRAL','Ток нейтрали превышает сумму фазных токов',`Iн=${fmt(v.neutralCurrent)} А; сумма фазных токов=${fmt(sum)} А.`, 'Проверить схему и сторону измерения нейтрали, датчики тока и синхронность значений. Гармоники могут повысить Iн относительно отдельной фазы; высокий Iн не доказывает перемычку или вмешательство.'));
  }
  if(u.every(x=>finite(x)&&x>=180)&&i.every(nonnegative)) {
    const max=Math.max(...i),min=Math.min(...i);
    if(max>=1&&max>=Math.max(0.05,min)*5) out.push(signal('J31_UNBALANCE','Значительная неравномерность фазных токов',`I1=${fmt(i[0])}, I2=${fmt(i[1])}, I3=${fmt(i[2])} А; все три фазных напряжения присутствуют.`, 'Оценить распределение однофазных нагрузок. Перекос токов сам по себе не является признаком недоучёта.',true));
  }
  return out;
}
function detectProfileSignals(v,reportPeriod) {
  const out=[],basis={timestampBasis:'report_period',reportPeriod:reportPeriod??null};
  const period=reportPeriod?`${reportPeriod.from} — ${reportPeriod.to}`:'не указан в шапке';
  // The profile summaries describe a reporting interval, not the B-cell
  // instant timestamp. No exact-time/monthly observation is fabricated.
  if(finite(v.reverseAvg)&&v.reverseAvg>=0.1||finite(v.reverseMax)&&v.reverseMax>=0.2)out.push({...signal('J31_REVERSE_PROFILE','Обратная активная мощность в профиле',`Период профиля: ${period}; A− среднее=${fmt(v.reverseAvg)} кВт, максимум=${fmt(v.reverseMax)} кВт. Это интервальные параметры, а не значение на время мгновенного измерения.`, 'Проверить разрешённую генерацию, полярность и схему подключения; уточнить покрытие профиля и коэффициенты трансформации. Обратное направление само по себе не подтверждает хищение.'),...basis,family:'direction'});
  for(const [prefix,label,unit]of [['forward','A+','кВт'],['reverse','A−','кВт'],['reactiveImport','R+','кВАр'],['reactiveExport','R−','кВАр']]) {
    const [min,avg,max]=['Min','Avg','Max'].map(suffix=>v[prefix+suffix]);
    const negative=[min,avg,max].some(x=>finite(x)&&x<-0.01);
    const inversion=(finite(min)&&finite(avg)&&min>avg+0.01)||(finite(avg)&&finite(max)&&avg>max+0.01)||(finite(min)&&finite(max)&&min>max+0.01);
    if(negative||inversion)out.push({...signal('J31_PROFILE_QUALITY','Проверить качество профильных min/среднего/max',`Профиль ${label}, период ${period}: минимум=${fmt(min)}, среднее=${fmt(avg)}, максимум=${fmt(max)} ${unit}. ${negative?'Есть отрицательный параметр направленного профиля. ':''}${inversion?'Нарушен порядок min ≤ среднее ≤ max.':''}`, 'Проверить соглашение о знаках направленных профилей, единицы, фильтр периода, полноту и правильность выгрузки. Ошибка профильных данных не является доказательством недоучёта.',true),...basis});
  }
  return out;
}
function extendDates(target,at) {
  if (!at) return;
  if (!target.first || at<target.first) target.first=at;
  if (!target.last || at>target.last) target.last=at;
}
function retainObservations(month,at,detail) {
  const observation={at,detail},records=month.observations;
  if(!records.length)records.push(observation);
  else if(records.length===1) {
    if(records[0].at!==at||records[0].detail!==detail) {
      records.push(observation);records.sort((a,b)=>a.at.localeCompare(b.at));
    }
  } else if(at<records[0].at)records[0]=observation;
  else if(at>=records[1].at)records[1]=observation;
  // Preserve the chronological first and last actual records. The old detail
  // field now describes the first record, not a value from a different day.
  month.detail=records[0].detail;
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
    const observationAt=hit.timestampBasis==='report_period'?null:at,oldFirst=current.first;
    // A period summary repeated across instant rows is one interval finding,
    // not many independent reverse-flow events.
    if(hit.timestampBasis==='report_period')current.count=1;else current.count++;
    extendDates(current,observationAt);
    if(observationAt&&(!oldFirst||observationAt<oldFirst))current.detail=hit.detail;
    if (observationAt) {
      const key=observationAt.slice(0,7); let month=current._months.get(key);
      if (!month) {month={month:key,count:0,first:null,last:null,detail:hit.detail,observations:[]};current._months.set(key,month);}
      month.count++; extendDates(month,observationAt);retainObservations(month,observationAt,hit.detail);
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

function physicalUnits(header,cols,warnings,sheet) {
  const scales=new Map(),knownUnits=new Set(),displacementFactors=new Set(),unknown=[],converted=[];
  const factor=prefix=>/[kк]/i.test(prefix)?1000:/[MМ]/.test(prefix)?1000000:/[mм]/.test(prefix)?0.001:1;
  for(const [key,col]of cols) {
    const text=clean(header[col]);let scale=1,known=true;
    const power=/^(forward|reverse|active|reactive|apparent)/.test(key);
    if(power) {
      const hit=text.match(/(?<![\p{L}])([kKкКmMмМ]?)(Вт|W|Вар|ВАр|вар|var|VAR|Ва|ВА|ва|VA)(?![\p{L}])/iu);
      if(hit) {
        const kind=/^(?:вт|w)$/i.test(hit[2])?'active':/^(?:вар|var)$/i.test(hit[2])?'reactive':'apparent';
        const wanted=/^reactive/.test(key)?'reactive':/^apparent/.test(key)?'apparent':'active';
        if(kind!==wanted)scale=null;
        else scale=factor(hit[1])*0.001;
      } else known=false;
    } else if(/^voltage/.test(key)||/^current/.test(key)||key==='neutralCurrent') {
      const voltage=/^voltage/.test(key),pattern=voltage?/(?<![\p{L}])([kKкКmMмМ]?)(?:В|в|V)(?![\p{L}])/iu:/(?<![\p{L}])([kKкКmMмМ]?)(?:А|а|A)(?![\p{L}])/iu;
      const hit=text.match(pattern);if(hit)scale=factor(hit[1]);else known=false;
    } else if(/^angle/.test(key)) {
      if(/град|°|deg/i.test(text))scale=1;
      else if(/рад|radian|\brad\b/i.test(text))scale=180/Math.PI;
      else known=false;
    } else if(/^powerFactor|^tangent/.test(key)) {
      if(text.includes('%'))scale=0.01;
      if(/^powerFactor/.test(key)&&/cos\s*(?:\(|φ|ф)/i.test(text))displacementFactors.add(key);
    }
    if(scale==null) {unknown.push(INSTANT_METRICS.find(m=>m.key===key).title+' (несоответствующая единица)');known=false;}
    else if(!known)unknown.push(INSTANT_METRICS.find(m=>m.key===key).title);
    else if(scale!==1)converted.push(INSTANT_METRICS.find(m=>m.key===key).title);
    scales.set(key,scale);if(known)knownUnits.add(key);
  }
  if(unknown.length)warnings.push(`Лист «${sheet}»: единицы не указаны или не соответствуют параметрам: ${unknown.join('; ')}. Приняты штатные единицы журнала 31; сравнение U×I/S и углов для этих столбцов ограничено. Столбцы с противоречащей единицей пропущены.`);
  if(converted.length)warnings.push(`Лист «${sheet}»: ${converted.join('; ')} пересчитаны в штатные единицы В/А/кВт/кВАр/кВА/градусы и доли коэффициентов.`);
  return {scales,knownUnits,displacementFactors};
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
    const unitContext=role==='instant'?physicalUnits(top[h],cols,warnings,name):null;
    const sheetUnscaled=role==='instant'&&top.slice(0,h).some(row=>/без учета коэффициентов трансформации/.test(norm(row.join(' '))));
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
      if(sheetUnscaled) coefficientMode='unscaled';
    }
    for(let r=h+1;r<=range.e.r;r++) {
      const serialCell=serialCol>=0?valueCell(ws,r,serialCol,XLSX):null,pointCell=pointCol>=0?valueCell(ws,r,pointCol,XLSX):null;
      const rawSerial=serialCol>=0?identifier(serialCell):serialFromPoint(pointCell?.v);
      const rawTime=valueCell(ws,r,timeCol,XLSX)?.v,rawInfo=role==='events'?valueCell(ws,r,9,XLSX)?.v:null;
      const values=role==='instant'?INSTANT_FIELDS.map(key=>{
        const raw=numeric(valueCell(ws,r,cols.get(key)??-1,XLSX)?.v),scale=unitContext.scales.get(key);
        const converted=raw!=null&&scale!=null?raw*scale:null;
        return finite(converted)?converted:null;
      }):null;
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
        const v=Object.fromEntries(INSTANT_FIELDS.map((key,j)=>[key,values[j]]));
        aggregateSignals(meter,[...detectSignals(v,{...unitContext,compareUI:sheetUnscaled}),...detectProfileSignals(v,reportPeriod)],at);stats.accepted++;
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
  if(role==='events')return {format:1,analysisVersion:JOURNAL_ANALYSIS_VERSION,role,rows:eventRows,stats,warnings};
  if(coefficientMode==='unscaled')warnings.push('Журнал 31 сформирован без коэффициентов трансформации. Мощность не сравнивается напрямую с объёмом потребления.');
  const output=[...meters.values()].map(({_signals,...meter})=>({...meter,signals:[..._signals.values()].map(({_months,...s})=>({...s,months:[..._months.values()].sort((a,b)=>a.month.localeCompare(b.month))}))}));
  return {format:1,analysisVersion:JOURNAL_ANALYSIS_VERSION,role,reportPeriod,coefficientMode,fields:[...INSTANT_FIELDS],meters:output,stats:{...stats,meters:output.length},warnings};
}
