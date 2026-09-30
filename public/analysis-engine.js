// Numerical engine adapted from the user-supplied analyzer v4.4.
// Embedded subscriber data and the original UI are not imported.
// The presentation layer displays measured observations without causal allegations.
const MONTHS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const MONTHS_FULL = ['январ','феврал','март','апрел','ма[йя]','июн','июл','август','сентябр','октябр','ноябр','декабр'];
const EPS = 3; // кВт·ч: всё, что ниже, считаем «практическим нулём»

/* ---------- калибровка чувствительности (v4) ----------
   Уровень s: -2 (намного мягче) … 0 (стандарт v3) … +2 (намного строже).
   «Строже» = жёстче критерий срабатывания признака И меньший его вес в риске.
   Для каждого алгоритма задан ряд из 5 значений порогов — по уровням s+2. */
const TUNE_DEFS = {
  sleeper:  {minZeros:[4,5,6,9,12], minPost:[30,40,50,90,150]},
  ragged:   {minSpike:[2.5,3,4,6,8], minTrans:[2,2,3,4,5]},
  step:     {rMax:[0.9,0.85,0.8,0.65,0.5]},
  valley:   {rMax:[0.6,0.55,0.5,0.4,0.3]},
  fade:     {rMax:[0.45,0.4,0.35,0.25,0.15]},
  zeroAlive:{minZeros:[2,2,3,5,7]},
  frozen:   {minRun:[3,3,4,5,6], maxCV:[4,3.5,3,2,1.5]},
  round:    {minShare:[0.55,0.6,0.7,0.8,0.9]},
  peers:    {maxFrac:[0.4,0.35,0.3,0.2,0.12]},
  season:   {maxOwn:[0.7,0.65,0.6,0.5,0.4]},
  idle:     {maxAvg:[25,20,15,8,4]},
  imb:      {minCorr:[0.5,0.55,0.6,0.7,0.8]},
  lone:     {minSum:[300,400,500,800,1200]},
  stepup:   {minJump:[2,2.2,2.5,3.5,5]},
  slow:     {rMax:[0.7,0.65,0.6,0.5,0.4]},
  // суточные признаки (только для суточных выгрузок)
  dzero:    {minDays:[2,3,4,6,8]},
  ddip:     {minRun:[3,4,5,7,10]},
  dsync:    {minCorr:[0.5,0.55,0.6,0.7,0.8]},
};
const PTS_FACTOR = [1.25, 1.1, 1, 0.85, 0.7]; // множитель веса признака по уровням

/* ---------- диапазоны техприсоединения (реестр СИП 0,22 / 0,4 кВ) ----------
   Разрешённая мощность попадает в диапазон; ВЕРХНЯЯ граница диапазона — это
   максимально возможная мощность потребителя, она даёт физический потолок
   месячного объёма (кВт × 730 ч). Оценка недоучёта не может превышать этот
   потолок за вычетом уже оплаченного (учтённого) объёма.
   Правило напряжения: ≤10 кВт — однофазное 0,22 кВ (типовой диапазон до 15 кВт,
   СИП-4 2×16); свыше 10 кВт — 0,4 кВ по умолчанию, диапазоны по длительно
   допустимому току СИП (ГОСТ 31946-2012, cos φ = 0,9). */
const POWER_BANDS = [
  {max:15,  u:'0,22', sip:'СИП-4 2×16'},
  {max:59,  u:'0,4',  sip:'СИП-4 4×16'},
  {max:77,  u:'0,4',  sip:'СИП-4 4×25'},
  {max:95,  u:'0,4',  sip:'СИП-4 4×35'},
  {max:116, u:'0,4',  sip:'СИП-4 4×50'},
  {max:142, u:'0,4',  sip:'СИП-4 4×70'},
  {max:178, u:'0,4',  sip:'СИП-4 4×95'},
  {max:201, u:'0,4',  sip:'СИП-4 4×120'},
  {max:225, u:'0,4',  sip:'СИП-4 4×150'},
  {max:258, u:'0,4',  sip:'СИП-4 4×185'},
  {max:305, u:'0,4',  sip:'СИП-4 4×240'},
];
const HOURS_MONTH = 730; // среднее число часов в месяце
function powerBand(power, voltage){
  // voltage — явное значение из колонки файла ('0,22' | '0,4'), если задано;
  // иначе правило по умолчанию: ≤10 кВт → 0,22 кВ, выше → 0,4 кВ
  if(power==null || !isFinite(power) || power<=0) return null;
  const explicit = voltage==='0,22' || voltage==='0,4';
  const u = explicit ? voltage : (power<=10 ? '0,22' : '0,4');
  if(u==='0,22'){
    const b=POWER_BANDS[0];
    return {u, explicit, capKw:Math.max(b.max, power), sip:b.sip,
      label: power<=b.max ? 'до '+b.max+' кВт (1ф)' : 'свыше '+b.max+' кВт (1ф)'};
  }
  let prev=null;
  for(const b of POWER_BANDS.slice(1)){
    if(power<=b.max) return {u, explicit, capKw:b.max, sip:b.sip, label:(prev==null?'до ':prev+' – ')+b.max+' кВт'};
    prev=b.max;
  }
  return {u, explicit, capKw:power, sip:'вне таблицы СИП', label:'свыше 305 кВт'};
}

function buildTune(levels){
  levels = levels || {};
  const out = {};
  for(const [k,def] of Object.entries(TUNE_DEFS)){
    const s = Math.max(-2, Math.min(2, Math.round(levels[k]||0)));
    const p = {level:s, ptsF:PTS_FACTOR[s+2]};
    for(const [name,arr] of Object.entries(def)) p[name] = arr[s+2];
    out[k] = p;
  }
  return out;
}
let TUNE = buildTune({});
function setTune(levels, cls){
  TUNE = buildTune(levels);
  if(cls){
    if(isFinite(cls.red)) CLS.red = cls.red;
    if(isFinite(cls.amber)) CLS.amber = Math.min(cls.amber, CLS.red - 5);
  }
}

/* ---------- режим зон рейтинга ----------
   'score' — зоны по риску 0–100 (стандарт);
   'loss'  — зоны по предполагаемому объёму недоучёта, кВт·ч. */
const MODE = { zone:'score', lossRed:5000, lossAmber:1000 };
function setZoneMode(zone, lossRed, lossAmber){
  MODE.zone = zone==='loss' ? 'loss' : 'score';
  if(isFinite(lossRed) && lossRed>0) MODE.lossRed = lossRed;
  if(isFinite(lossAmber) && lossAmber>0) MODE.lossAmber = Math.min(lossAmber, MODE.lossRed);
}

/* ---------- бусты приоритета (чек-боксы в Методике) ----------
   Включённый буст добавляет баллы всем ПУ, подходящим под условие, —
   такие потребители поднимаются в рейтинге (и могут сменить зону). */
const BOOST_DEFS = [
  {id:'ul',        pts:10, label:'Юридические лица',                     test:c=>c.ctype==='ul'},
  {id:'fl',        pts:10, label:'Физические лица (быт)',                test:c=>c.ctype==='fl'},
  {id:'power30',   pts:10, label:'Разрешённая мощность ≥ 30 кВт',        test:c=>c.power!=null && c.power>=30},
  {id:'bigloss',   pts:10, label:'Оценка недоучёта ≥ 3000 кВт·ч',        test:c=>c.lossKwh>=3000},
  {id:'winterzero',pts:8,  label:'Есть нули в зимние месяцы',            test:c=>c.winterZeros>=1},
  {id:'shift',     pts:8,  label:'Есть точка перелома на графике',       test:c=>c.shiftIdx!=null},
  {id:'dup',       pts:6,  label:'Дубль номера ПУ в файле',              test:c=>!!c.dup},
];
let BOOSTS_ON = {};
function setBoosts(on){ BOOSTS_ON = on || {}; }

/* ---------- включение/исключение алгоритмов ----------
   Отключённый признак не срабатывает вовсе и не гейтит остальные —
   методика адаптируется под район (промзона / газ / электроотопление…). */
let ALG_OFF = {};
function setAlgOff(off){ ALG_OFF = off || {}; }

function median(arr){
  const a = arr.filter(v => v != null && isFinite(v)).slice().sort((x,y)=>x-y);
  if(!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}
function mean(arr){
  const a = arr.filter(v => v != null && isFinite(v));
  return a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
}
function stdev(arr){
  const a = arr.filter(v => v != null && isFinite(v));
  if(a.length < 3) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);
}
function pearson(x, y){
  const idx = [];
  for(let i=0;i<x.length;i++) if(x[i]!=null && y[i]!=null) idx.push(i);
  if(idx.length < 6) return 0;
  const xs = idx.map(i=>x[i]), ys = idx.map(i=>y[i]);
  const mx = mean(xs), my = mean(ys);
  let num=0, dx=0, dy=0;
  for(let i=0;i<xs.length;i++){
    num += (xs[i]-mx)*(ys[i]-my);
    dx += (xs[i]-mx)**2; dy += (ys[i]-my)**2;
  }
  return (dx>0 && dy>0) ? num/Math.sqrt(dx*dy) : 0;
}
function fmt(n, digits){
  if(n == null || !isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', {maximumFractionDigits: digits==null?0:digits});
}
function isWinter(ym){ return ym.m === 11 || ym.m === 0 || ym.m === 1; }
function isSummer(ym){ return ym.m >= 5 && ym.m <= 7; }
function ymLabel(ym){ return MONTHS_RU[ym.m] + '\u00A0' + String(ym.y).slice(2); }
/* ---------- сутки ---------- */
function dLabel(d){ return String(d.d).padStart(2,'0')+'.'+String(d.m+1).padStart(2,'0')+'.'+String(d.y).slice(2); }
function daysInMonth(y,m){ return new Date(y, m+1, 0).getDate(); }
function dayAdd(d, n){ const t=new Date(d.y, d.m, d.d+n); return {y:t.getFullYear(), m:t.getMonth(), d:t.getDate(), hasYear:d.hasYear}; }
function dayNum(d){ return Math.round(Date.UTC(d.y, d.m, d.d)/86400000); }
// заголовок-дата: Date, Excel-серийное число, «01.01.2025», «2025-01-01», «1 янв 25», «01.01»
function parseDayHeader(v){
  if(v == null) return null;
  // даты Excel из SheetJS в часовых поясах восточнее Гринвича приходят как «предыдущий день 23:59:43»
  // (историческое смещение 1899 г.) — берём ближайшие сутки (+12 ч), а не календарную дату объекта
  if(v instanceof Date && !isNaN(v)){ const t=new Date(v.getTime()+43200000); return {y:t.getFullYear(), m:t.getMonth(), d:t.getDate(), hasYear:true}; }
  if(typeof v === 'number'){
    if(v > 20000 && v < 80000){ const t=new Date(Math.round((v-25569)*86400*1000)); return {y:t.getUTCFullYear(), m:t.getUTCMonth(), d:t.getUTCDate(), hasYear:true}; }
    return null;
  }
  const s = String(v).trim().toLowerCase();
  if(!s) return null;
  let m;
  if((m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})(?!\d)/))){
    let y=+m[3]; if(y<100) y+=2000; const mo=+m[2], d=+m[1];
    if(mo>=1&&mo<=12&&d>=1&&d<=31) return {y, m:mo-1, d, hasYear:true};
  }
  if((m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?!\d)/))){
    const mo=+m[2], d=+m[3];
    if(mo>=1&&mo<=12&&d>=1&&d<=31) return {y:+m[1], m:mo-1, d, hasYear:true};
  }
  if((m = s.match(/^(\d{1,2})\s+([а-яё]+)\.?(?:\s+(\d{2,4}))?/))){
    const d=+m[1], mon=m[2];
    for(let mi=0; mi<12; mi++){
      if(new RegExp('^'+MONTHS_FULL[mi],'i').test(mon) || mon.startsWith(MONTHS_RU[mi])){
        if(d<1||d>31) return null;
        if(m[3]){ let y=+m[3]; if(y<100) y+=2000; return {y, m:mi, d, hasYear:true}; }
        return {y:null, m:mi, d, hasYear:false};
      }
    }
  }
  if((m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})$/))){
    const d=+m[1], mo=+m[2];
    if(mo>=1&&mo<=12&&d>=1&&d<=31) return {y:null, m:mo-1, d, hasYear:false};
  }
  return null;
}
// сутки или месяцы? По медиане разрыва между соседними распознанными датами шапки:
// ≤3 дня — суточная выгрузка; иначе (≈30 дней, «01.01.2025 / 01.02.2025») — месячная.
function detectGran(headerVals){
  const ds=headerVals.map(parseDayHeader).filter(Boolean);
  if(ds.length<3) return 'month';
  const nums=ds.map(d=>d.hasYear?dayNum(d):dayNum({y:2001, m:d.m, d:d.d})).sort((a,b)=>a-b);
  const gaps=[]; for(let i=1;i<nums.length;i++){ const g=nums[i]-nums[i-1]; if(g>0) gaps.push(g); }
  if(gaps.length<2) return 'month';
  return median(gaps)<=3 ? 'day' : 'month';
}

/* ---------- шапка: распознавание месяцев ---------- */
function excelSerialToYM(n){
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  return isNaN(d) ? null : {y: d.getUTCFullYear(), m: d.getUTCMonth()};
}
function parseMonthHeader(v){
  if(v == null) return null;
  if(v instanceof Date && !isNaN(v)){ const t=new Date(v.getTime()+43200000); return {y:t.getFullYear(), m:t.getMonth(), hasYear:true}; }
  if(typeof v === 'number'){
    return (v > 20000 && v < 80000) ? {...excelSerialToYM(v), hasYear:true} : null;
  }
  const s = String(v).trim().toLowerCase();
  if(!s) return null;
  let m;
  if((m = s.match(/^(\d{1,2})[.\-\/](\d{4})/)) && +m[1]>=1 && +m[1]<=12) return {y:+m[2], m:+m[1]-1, hasYear:true};
  if((m = s.match(/^(\d{4})[.\-\/](\d{1,2})/)) && +m[2]>=1 && +m[2]<=12) return {y:+m[1], m:+m[2]-1, hasYear:true};
  if((m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/)) && +m[2]>=1 && +m[2]<=12) return {y:+m[3], m:+m[2]-1, hasYear:true};
  for(let mi=0; mi<12; mi++){
    if(new RegExp('^'+MONTHS_FULL[mi], 'i').test(s) || s.startsWith(MONTHS_RU[mi])){
      const ym = s.match(/(20\d{2}|\b\d{2}\b)/);
      if(ym){ let y=+ym[1]; if(y<100) y+=2000; return {y, m:mi, hasYear:true}; }
      return {y:null, m:mi, hasYear:false};
    }
  }
  return null;
}

function algSleeper(v, months){
  const T=TUNE.sleeper;
  let z=0;
  while(z<v.length && (v[z]==null || v[z]<=EPS)) z++;
  if(z<T.minZeros || z>v.length-4) return null;
  const zeros = v.slice(0,z).filter(x=>x!=null && x<=EPS).length;
  if(zeros < T.minZeros) return null;
  const after = v.slice(z).filter(x=>x!=null);
  const post = median(after);
  if(post==null || post<T.minPost) return null;
  const sustained = after.filter(x=>x>EPS).length/after.length;
  if(sustained<0.7) return null;
  const pts = Math.min(50, Math.round(18 + 1.5*zeros + (post>=300?10:post>=100?6:0)));
  const loss = Math.round(post*zeros);
  return {pts, loss, shiftIdx:z, base:post,
    detail:`${zeros} мес. нулей с начала ряда, затем с ${ymLabel(months[z])} — устойчивые ~${fmt(post)} кВт·ч/мес. Действующий объект не «включается из ниоткуда»: до пробуждения он, скорее всего, потреблял мимо учёта. Оценка недоучёта ≈ ${fmt(loss)} кВт·ч.`};
}

// S2. «Рваный профиль»: нули вперемешку со всплесками — похоже на разовые контрольные съёмы
function algRagged(v, months){
  const T=TUNE.ragged;
  const known = v.filter(x=>x!=null);
  if(known.length<10) return null;
  const zeros = known.filter(x=>x<=EPS).length;
  const zShare = zeros/known.length;
  if(zShare<0.2 || zShare>0.85) return null;
  const pos = known.filter(x=>x>EPS);
  const mp = median(pos);
  if(mp==null || mean(known)<40) return null;
  const mx = Math.max(...pos);
  const spike = mx/mp;
  if(spike<T.minSpike) return null;
  let trans=0;
  for(let i=1;i<v.length;i++){
    const a=v[i-1], b=v[i];
    if(a!=null && b!=null && ((a<=EPS)!==(b<=EPS))) trans++;
  }
  if(trans<T.minTrans) return null;
  let wz=0;
  v.forEach((x,i)=>{ if(x!=null&&x<=EPS&&isWinter(months[i])) wz++; });
  const pts = Math.min(45, Math.round(24 + (zShare>=0.25&&zShare<=0.7?8:4) + Math.min(10,spike) + Math.min(7,trans) + Math.min(4,2*wz)));
  const loss = Math.round(zeros*mp);
  return {pts, loss, base:mp,
    detail:`Профиль «рваный»: ${zeros} нулевых мес. чередуются со всплесками до ${fmt(mx)} кВт·ч (в ${fmt(spike,1)} раза выше типичного). Так выглядит учёт, который «оживает» только при контрольных съёмах, — остальное время энергия идёт мимо ПУ. Оценка недоучёта ≈ ${fmt(loss)} кВт·ч.`};
}

// Групповая поправка «до/после»: как просела сама группа вокруг той же точки.
// Возвращает ratio группы (после/до) либо null, если посчитать нельзя.
function groupStepRatio(gMed, t){
  if(!gMed) return null;
  const gb=median(gMed.slice(0,t)), ga=median(gMed.slice(t));
  return (gb!=null && ga!=null && gb>=20) ? ga/gb : null;
}

// S3. Ступенчатое падение: расход упал и держится на низком уровне до конца ряда.
// Устойчивость проверяется двумя путями: по доле месяцев ниже порога И по медианам
// годовых блоков (второй путь не даёт сезонным пикам маскировать ступень).
function algStepDrop(v, months, gMed, gCnt){
  const T=TUNE.step;
  const n=v.length;
  const yearBlocksBelow = (t, thr) => { // все 12-мес. блоки после t ниже порога?
    let all=true, cnt=0;
    for(let y0=t; y0<n; y0+=12){
      const seg=v.slice(y0,Math.min(n,y0+12)).filter(x=>x!=null);
      if(seg.length<4) continue;
      cnt++;
      if(median(seg)>=thr) all=false;
    }
    return cnt>=1 && all;
  };
  let bestR=null;
  for(let t=3; t<=n-3; t++){
    const before=v.slice(0,t), after=v.slice(t);
    const mb=median(before), ma=median(after);
    if(mb==null||ma==null||mb<40) continue;
    const aKnown=after.filter(x=>x!=null);
    if(aKnown.length<3) continue;
    const ratio=ma/mb;
    if(ratio>T.rMax) continue; // калибровка: ступень мельче настроенного порога не считается
    let ok=false;
    if(ratio<=0.5){
      ok = aKnown.filter(x=>x<mb*0.8).length/aKnown.length >= 0.75 || yearBlocksBelow(t, mb*0.8);
    } else if(ratio<=0.65){
      ok = aKnown.filter(x=>x<mb*0.8).length/aKnown.length >= 0.85 || yearBlocksBelow(t, mb*0.8);
    } else if(ratio<=Math.max(0.8, T.rMax)){
      // неглубокая ступень: только длинная и очень устойчивая
      ok = aKnown.length>=12 && (aKnown.filter(x=>x<mb*0.9).length/aKnown.length >= 0.85 || yearBlocksBelow(t, mb*0.9));
    }
    if(!ok) continue;
    const cand={t,mb,ma,ratio,after:aKnown.length};
    // из почти одинаковых по глубине точек берём САМУЮ РАННЮЮ — она и есть начало ступени
    if(!bestR || ratio<bestR.ratio*0.85) bestR=cand;
  }
  if(!bestR) return null;
  const r=bestR.ratio;
  let pts = r<=0.25?44 : r<=0.35?38 : r<=0.5?30 : r<=0.65?22 : 12;
  if(r<=0.5 && bestR.after>=18) pts+=6;            // глубокая ступень держится 1,5+ года
  if(r>0.65){                                       // неглубокая: вес растёт с выдержкой
    if(bestR.after>=24) pts+=4;
    if(bestR.after>=48) pts+=4;
  }
  // групповая поправка: если группа за ту же точку тоже просела — часть падения общая
  let grpNote='';
  const gr = (gCnt>=6) ? groupStepRatio(gMed, bestR.t) : null;
  if(gr!=null && gr<=0.75){
    pts=Math.max(6, Math.round(pts*0.6));
    grpNote=` Но группа вокруг той же даты тоже просела до ${fmt(gr*100)}% — часть падения может быть общей (сезонность, экономика), балл снижен.`;
  }
  let loss=0;
  for(let i=bestR.t;i<n;i++) if(v[i]!=null) loss+=Math.max(0,bestR.mb-v[i]);
  loss=Math.round(loss);
  return {pts, loss, shiftIdx:bestR.t, base:bestR.mb,
    detail:`С ${ymLabel(months[bestR.t])} расход ступенью упал с ~${fmt(bestR.mb)} до ~${fmt(bestR.ma)} кВт·ч/мес (−${fmt((1-r)*100)}%) и не восстановился (${bestR.after} мес. на новом уровне). Классика вмешательства: магнит, шунт, обвод — либо объект обесточен/покинут (сверить со статусом договора). Оценка недоучёта ≈ ${fmt(loss)} кВт·ч.${grpNote}`};
}

// S3b. Провал с восстановлением: «яма» посреди ряда — воровали до проверки/доначисления
function algValley(v, months){
  const T=TUNE.valley;
  const n=v.length;
  let bestV=null;
  for(let i=3;i<n-6;i++) for(let j=i+4;j<=Math.min(n-3,i+24);j++){
    const inside=v.slice(i,j);
    if(inside.filter(x=>x!=null).length<4) continue;
    const mL=median(v.slice(0,i)), mR=median(v.slice(j));
    if(mL==null||mR==null||mL<100||mR<100) continue;
    const mi=median(inside), side=Math.min(mL,mR);
    if(mi==null) continue;
    const ratio=mi/side;
    if(ratio<=T.rMax && (!bestV || ratio<bestV.ratio || (ratio===bestV.ratio && (j-i)>(bestV.j-bestV.i)))) bestV={i,j,mi,mL,side,ratio};
  }
  if(!bestV) return null;
  const len=bestV.j-bestV.i;
  const pts=Math.min(34, Math.round(16 + (1-bestV.ratio)*18 + (len>=12?4:0)));
  let loss=0;
  for(let k=bestV.i;k<bestV.j;k++) if(v[k]!=null) loss+=Math.max(0,bestV.mL-v[k]);
  loss=Math.round(loss);
  return {pts, loss, shiftIdx:bestV.i, endIdx:bestV.j, base:bestV.mL,
    detail:`Провал ${ymLabel(months[bestV.i])} — ${ymLabel(months[bestV.j-1])} (${len} мес.): ~${fmt(bestV.mi)} кВт·ч/мес при ~${fmt(bestV.side)} по обе стороны (−${fmt((1-bestV.ratio)*100)}%), затем уровень восстановился. Типичная картина «вмешательство → контрольная проверка/доначисление». Недоучёт за провал ≈ ${fmt(loss)} кВт·ч (от уровня до провала).`};
}

// S4. Затухание: последние месяцы — доли собственной базы
function algFade(v, months){
  const T=TUNE.fade;
  const n=v.length;
  if(n<8) return null;
  const early=median(v.slice(0,n-4)), late=median(v.slice(-4));
  if(early==null||late==null||early<40) return null;
  const r=late/early;
  if(r>T.rMax) return null;
  const pts = r<=0.15?14:8;
  return {pts, detail:`Последние месяцы ~${fmt(late)} кВт·ч при собственной базе ~${fmt(early)} (${fmt(r*100)}%). Потребление «затухает» без явной сезонной причины.`};
}

// S5. Нули при живой группе
function algZeroAlive(v, months, gMed){
  const T=TUNE.zeroAlive;
  const zi=[];
  v.forEach((x,i)=>{ if(x!=null && x<=EPS && gMed[i]!=null && gMed[i]>=25) zi.push(i); });
  if(zi.length<T.minZeros) return null;
  const wz=zi.filter(i=>isWinter(months[i])).length;
  return {pts:Math.min(14, Math.round(4+2*zi.length+2*wz)),
    detail:`${zi.length} нулевых мес. (зимой — ${wz}) при живом потреблении соседей по группе. Ноль зимой на действующем объекте — почти всегда обвод либо брошенный объект.`};
}

// S6. Замороженные/неправдоподобно плоские показания
function algFrozen(v){
  const T=TUNE.frozen;
  let run=1,bestRun=1,val=null;
  for(let i=1;i<v.length;i++){
    if(v[i]!=null && v[i]===v[i-1] && v[i]>EPS){ run++; if(run>bestRun){bestRun=run; val=v[i];} }
    else run=1;
  }
  if(bestRun>=T.minRun) return {pts:Math.min(14,3*bestRun), detail:`«Замороженное» показание: ${bestRun} мес. подряд ровно ${fmt(val)} кВт·ч. Либо счётчик стоит, либо переписывают одну цифру.`};
  const pos=v.filter(x=>x!=null&&x>EPS);
  const m=mean(pos), sd=stdev(pos);
  if(m!=null&&sd!=null&&pos.length>=8&&m>=30&&sd/m<=T.maxCV/100)
    return {pts:11, detail:`Разброс аномально мал (CV=${fmt(sd/m*100,1)}%). Живое потребление так не выглядит — похоже на «рисованные» передачи.`};
  return null;
}

// S7. Круглые числа
function algRound(v){
  const T=TUNE.round;
  const pos=v.filter(x=>x!=null&&x>EPS);
  if(pos.length<8) return null;
  const r=pos.filter(x=>x%50===0).length/pos.length;
  if(r<T.minShare) return null;
  return {pts:6, weak:true, detail:`${fmt(r*100)}% значений кратны 50 — показания передаются «на глаз», без реального съёма. Повод для контрольного обхода.`};
}

// S8. Ниже соседей по группе (слабый)
function algBelowPeers(v, gs){
  const T=TUNE.peers;
  if(gs.cnt<8||gs.groupMedian==null||gs.groupMedian<60) return null;
  const m=mean(v);
  if(m==null||m>=gs.groupMedian*T.maxFrac||(gs.p10!=null&&m>=gs.p10)) return null;
  return {pts:8, weak:true, detail:`Средний расход ${fmt(m)} кВт·ч/мес — ниже 30% медианы группы (${fmt(gs.groupMedian)}). Само по себе — слабый признак (может быть малый/пустующий объект), но в связке с другими усиливает подозрение.`};
}

// S9. Против сезона (относительно группы)
function algSeason(v, months, gWS){
  if(gWS==null||gWS<1.05) return null;
  const w=[],s=[];
  months.forEach((ym,i)=>{ if(v[i]!=null){ if(isWinter(ym))w.push(v[i]); if(isSummer(ym))s.push(v[i]); }});
  if(w.length<2||s.length<2) return null;
  const ms=median(s);
  if(ms==null||ms<40) return null;
  const own=median(w)/ms;
  if(own>TUNE.season.maxOwn*gWS) return null;
  return {pts:10, detail:`Зима/лето здесь ${fmt(own,2)} против ${fmt(gWS,2)} по группе: у соседей зимой расход растёт, тут — проваливается. Типично для сезонного «прикручивания» учёта.`};
}

// S10. Мощность простаивает (слабый): подключение есть, расхода почти нет
function algIdlePower(v, power){
  const T=TUNE.idle;
  if(power==null||power<10) return null;
  const m=mean(v);
  if(m==null) return null;
  if(m<=T.maxAvg){
    const nz=v.filter(x=>x!=null&&x>EPS).length;
    return {pts:7, weak:true, detail:`Разрешённая мощность ${fmt(power)} кВт, а фактический расход ~${fmt(m,1)} кВт·ч/мес (${nz} активных мес.). Проверить, не запитан ли объект мимо ПУ и жив ли договор.`};
  }
  if(power>=30){
    const cap=power*730; // теоретический потолок за месяц при полной загрузке
    const thr = (power>=200?0.05 : power>=100?0.03 : 0.015) * (T.maxAvg/15);
    if(m<cap*thr) return {pts:8, weak:true, detail:`Разрешённая мощность ${fmt(power)} кВт — это до ~${fmt(cap)} кВт·ч/мес, а через ПУ проходит ~${fmt(m)} (${fmt(m/cap*100,1)}% мощности). Для объекта, бравшего такую мощность, это мало: либо мощность «бумажная», либо часть нагрузки запитана мимо учёта.`};
  }
  return null;
}

// S11. Синхронность с небалансом ТП
function algImbalance(v, imb, months){
  if(!imb) return null;
  const n=v.length;
  const early=median(v.slice(0,Math.max(3,Math.floor(n/2))));
  if(early==null||early<30) return null;
  const deficit=v.map(x=>x==null?null:Math.max(0,early-x));
  const r=pearson(deficit,imb);
  const dSum=deficit.reduce((s,x)=>s+(x||0),0);
  if(r<TUNE.imb.minCorr||dSum<early*2) return null;
  return {pts:12, detail:`Провалы этого ПУ синхронны с ростом небаланса по вводу ТП (корреляция ${fmt(r,2)}). Недоучтённая энергия «всплывает» в потерях подстанции — сильный подтверждающий признак.`};
}

// S12. Разовый всплеск среди «мёртвого» ряда — похоже на доначисление/акт
function algLoneSpike(v){
  const known=v.filter(x=>x!=null);
  if(known.length<10) return null;
  const zeros=known.filter(x=>x<=EPS).length;
  if(zeros/known.length<0.6) return null;
  const pos=known.filter(x=>x>EPS);
  const big=pos.filter(x=>x>=400), small=pos.filter(x=>x<400);
  if(big.length<1||big.length>2||small.length>6) return null;
  const s=big.reduce((a,b)=>a+b,0);
  if(s<TUNE.lone.minSum) return null;
  return {pts:12, weak:true, detail:`Ряд почти полностью нулевой, но есть разовый объём ${fmt(s)} кВт·ч. Похоже на доначисление по акту или съём накопленного при проверке — до и после объект для учёта «не существует». Поднять историю: что это был за объём и почему после него снова тишина.`};
}

// S13. Ступенчатый рост с низкой базы: долго «по чуть-чуть», потом резко в разы больше.
// Зеркало S3: недоучёт был В НАЧАЛЕ ряда — до замены ПУ / проверки / пресечения.
function algStepUp(v, months){
  const n=v.length;
  let best=null;
  for(let t=6; t<=n-6; t++){
    const pre=v.slice(0,t).filter(x=>x!=null), post=v.slice(t).filter(x=>x!=null);
    if(pre.length<5||post.length<5) continue;
    const mp=median(pre), mq=median(post);
    if(mp==null||mq==null||mp<20||mq<200) continue; // нули с начала — это S1, не сюда
    const jump=mq/mp;
    if(jump<TUNE.stepup.minJump) continue;
    if(post.filter(x=>x>mp*1.5).length/post.length < 0.8) continue;  // новый уровень устойчив
    if(pre.filter(x=>x<mq*0.6).length/pre.length < 0.8) continue;    // старый был стабильно низким
    if(!best || jump>best.jump) best={t,mp,mq,jump,preCnt:pre.length};
  }
  if(!best) return null;
  // резкость перехода: медиана 4 мес. после точки против 4 мес. до неё
  const w1=v.slice(Math.max(0,best.t-4),best.t).filter(x=>x!=null);
  const w2=v.slice(best.t,best.t+4).filter(x=>x!=null);
  const sharp=(w1.length>=2&&w2.length>=2&&median(w1)>0)?median(w2)/median(w1):null;
  const isSharp = sharp!=null && sharp>=2;
  let pts, weak=false;
  if(isSharp) pts = best.jump>=8?28 : best.jump>=5?24 : best.jump>=3.5?18 : 14;
  else if(best.jump>=8) pts=24;      // рост на порядок даже «плавно» — слишком много для роста бизнеса
  else if(best.jump>=4) pts=20;
  else { pts=12; weak=true; }        // плавный умеренный рост — бизнес мог просто вырасти
  const loss=Math.round((best.mq-best.mp)*best.preCnt);
  return {pts, weak, loss, shiftIdx:best.t, base:best.mq,
    detail:`До ${ymLabel(months[best.t])} через ПУ шло ~${fmt(best.mp)} кВт·ч/мес, после — устойчивые ~${fmt(best.mq)} (рост в ${fmt(best.jump,1)} раза${isSharp?', скачком':', плавно'}). Объект, который «вдруг» стал потреблять в разы больше, чаще всего потреблял столько и раньше — мимо учёта. Сверить дату скачка с заменой ПУ/проверкой. Оценка недоучёта за период до скачка ≈ ${fmt(loss)} кВт·ч.`};
}

// S14. Многолетнее угасание: год за годом вниз без резкой ступени.
// Ловит «аккуратное» хищение, растянутое по времени, — на длинных рядах (2,5+ года).
function algSlowDecline(v, months, gMed, gCnt, stepPts){
  const n=v.length;
  if(n<30 || stepPts>=30) return null; // короткий ряд / резкую ступень уже взял S3
  const yearsOf = series => {
    const ys=[];
    for(let y0=0; y0+6<=series.length; y0+=12){
      const seg=series.slice(y0,Math.min(series.length,y0+12)).filter(x=>x!=null);
      ys.push(seg.length>=6?median(seg):null);
    }
    return ys;
  };
  const years=yearsOf(v);
  const idx=[]; years.forEach((x,i)=>{ if(x!=null) idx.push(i); });
  if(idx.length<4) return null;
  const yv=idx.map(i=>years[i]);
  let peakI=0; yv.forEach((x,i)=>{ if(x>yv[peakI]) peakI=i; });
  const peak=yv[peakI], last=yv[yv.length-1];
  if(peak<100 || peakI>=yv.length-2) return null; // падение должно быть видно ≥2 лет
  const r=last/peak;
  if(r>TUNE.slow.rMax) return null;
  let down=0, steps=0;
  for(let i=peakI;i<yv.length-1;i++){ steps++; if(yv[i+1]<=yv[i]*1.1) down++; }
  if(steps<2 || down/steps<0.7) return null;
  let pts = r<=0.3?28 : r<=0.5?22 : 16;
  let grpNote='';
  if(gCnt>=6 && gMed){
    const gy=yearsOf(gMed).filter(x=>x!=null);
    if(gy.length>=3){
      const gr=gy[gy.length-1]/Math.max(...gy);
      if(gr<=0.75){
        pts=Math.max(6, Math.round(pts*0.6));
        grpNote=` Но группа за эти годы тоже просела до ${fmt(gr*100)}% — часть спада может быть общей, балл снижен.`;
      }
    }
  }
  const loss=Math.round((peak-last)*12);
  return {pts, loss, base:peak,
    detail:`Годовые уровни ползут вниз: с ~${fmt(peak)} кВт·ч/мес в пиковый год до ~${fmt(last)} в последний (−${fmt((1-r)*100)}%), без резкой ступени. Так выглядит «аккуратное» хищение, наращиваемое постепенно, — или медленное сворачивание деятельности (сверить с состоянием объекта). Только за последний год недоучёт ≈ ${fmt(loss)} кВт·ч от пикового уровня.${grpNote}`};
}

/* ================= СУТОЧНЫЕ ПРИЗНАКИ (D1–D3) =================
   Работают на суточном ряду АСКУЭ, когда месячных сумм для S1–S14 мало
   (короткая выгрузка) — и как дополнение на длинных суточных рядах.
   Оценка недоучёта — недостача до собственной суточной базы в «подозрительные» дни. */
const EPS_D = 0.3; // кВт·ч/сут: ниже — «выключенный» объект (даже холодильник даёт ~1 кВт·ч/сут)

// D1. Нулевые сутки при живой группе — объект «выключается» на день, пока соседи потребляют
function algDayZero(dv, gMedD){
  const T=TUNE.dzero;
  const known=dv.filter(x=>x!=null);
  const act=known.filter(x=>x>EPS_D);
  if(act.length<7) return null;
  const dBase=median(act);
  if(dBase<1) return null;
  const zi=[];
  dv.forEach((x,i)=>{ if(x!=null && x<=EPS_D && gMedD && gMedD[i]!=null && gMedD[i]>=1) zi.push(i); });
  if(zi.length<T.minDays) return null;
  const zerosAll=known.filter(x=>x<=EPS_D).length;
  if(zerosAll/known.length>0.6) return null; // объект по большей части пуст (дача выходного дня) — не признак
  const pts=Math.min(16, 4+2*zi.length);
  const loss=Math.round(dBase*zi.length);
  return {pts, loss, dBase, dayIdx:zi,
    detail:`${zi.length} суток с нулём при живом потреблении соседей; собственная база ~${fmt(dBase,1)} кВт·ч/сут. Объект, который «выключается» на сутки, пока соседи потребляют, — либо обвод/отключение учёта, либо реальные отъезды: сверить с журналом событий ПУ. Недоучёт ≈ ${fmt(loss)} кВт·ч.`};
}

// D2. Затяжной суточный провал — серия дней ниже 30% собственной суточной базы после активного периода
function algDayDip(dv, excl){
  const T=TUNE.ddip;
  const skip = excl && excl.length ? new Set(excl) : null; // дни, уже засчитанные D1, — как «нет данных»
  const act=dv.filter(x=>x!=null&&x>EPS_D);
  if(act.length<10) return null;
  const dBase=median(act);
  if(dBase<2) return null;
  // серии подряд идущих дней ниже 30% базы; 1–2 дня без данных внутри серии её не рвут, 3 и больше — рвут
  const runs=[]; let cur=[], gap=0;
  const close=()=>{ if(cur.length>=T.minRun) runs.push(cur); cur=[]; gap=0; };
  for(let i=0;i<dv.length;i++){
    const x=(skip && skip.has(i)) ? null : dv[i];
    if(x==null){ if(cur.length && ++gap>=3) close(); continue; }
    gap=0;
    if(x<dBase*0.3) cur.push(i); else close();
  }
  close();
  // самая длинная серия из тех, перед которыми было ≥5 активных дней (провал с самого начала ряда сравнивать не с чем);
  // при равной длине — более поздняя
  let best=null, before=0;
  for(const r of runs){ const b=dv.slice(0,r[0]).filter(x=>x!=null&&x>EPS_D).length; if(b<5) continue; if(!best || r.length>=best.length){ best=r; before=b; } }
  if(!best) return null;
  const dayIdx=best.slice();
  let loss=0; for(const i of dayIdx) loss+=Math.max(0,dBase-dv[i]);
  loss=Math.round(loss);
  const pts=Math.min(28, 10+Math.round(dayIdx.length*1.2));
  return {pts, loss, dBase, dayIdx, shiftDay:dayIdx[0],
    detail:`Провал ${dayIdx.length} сут. ниже 30% собственной суточной базы (~${fmt(dBase,1)} кВт·ч/сут) после ${before} активных дней (дни без данных не в счёт). На суточном масштабе так выглядит вмешательство или отключение учёта — сверить с журналом событий ПУ и статусом объекта. Недоучёт за провал ≈ ${fmt(loss)} кВт·ч.`};
}

// D3. Синхронность с суточным небалансом ТП — провалы ПУ совпадают с ростом небаланса по дням
function algDaySync(dv, imbD){
  if(!imbD) return null;
  const T=TUNE.dsync;
  const act=dv.filter(x=>x!=null&&x>EPS_D);
  if(act.length<10) return null;
  const dBase=median(act);
  if(dBase<1) return null;
  const def=dv.map(x=>x==null?null:Math.max(0,dBase-x));
  const r=pearson(def, imbD);
  const dSum=def.reduce((s,x)=>s+(x||0),0);
  if(r<T.minCorr || dSum<dBase*3) return null;
  return {pts:12, dBase,
    detail:`Суточные провалы этого ПУ совпадают с ростом небаланса ТП по дням (корреляция ${fmt(r,2)}). Недоучтённая энергия «всплывает» в потерях подстанции в те же сутки — сильный подтверждающий признак; объём недоучёта оценивают D1/D2 и месячные признаки.`};
}

const ALG_META = {
  sleeper:{code:'S1', title:'Спящий → пробуждение'},
  ragged:{code:'S2', title:'Рваный профиль: нули со всплесками'},
  step:{code:'S3', title:'Ступенчатое падение'},
  valley:{code:'S3б', title:'Провал с восстановлением'},
  fade:{code:'S4', title:'Затухание расхода'},
  zeroAlive:{code:'S5', title:'Нули при живой группе'},
  frozen:{code:'S6', title:'Замороженные показания'},
  round:{code:'S7', title:'Круглые числа'},
  peers:{code:'S8', title:'Ниже соседей по группе'},
  season:{code:'S9', title:'Против сезона'},
  idle:{code:'S10', title:'Мощность простаивает'},
  imb:{code:'S11', title:'Синхронность с небалансом ТП'},
  lone:{code:'S12', title:'Разовый всплеск в мёртвом ряду'},
  stepup:{code:'S13', title:'Ступенчатый рост с низкой базы'},
  slow:{code:'S14', title:'Многолетнее угасание'},
  dzero:{code:'D1', title:'Нулевые сутки при живой группе'},
  ddip:{code:'D2', title:'Суточный провал'},
  dsync:{code:'D3', title:'Синхронность с суточным небалансом'},
};

const CLS = { red:45, amber:20 };

function analyze(data, tariff){
  const {meters, months, supplyRows} = data;
  const days = data.days || null, monthDays = data.monthDays || null;
  const n = months.length;

  // группы (по ТП, если колонка есть; иначе весь файл)
  const groups={};
  for(const m of meters){ const g=m.tp||'__all__'; (groups[g]=groups[g]||[]).push(m); }
  const buildStats = arr => {
    const medByMonth=months.map((_,i)=>median(arr.map(m=>m.values[i])));
    const means=arr.map(m=>mean(m.values)).filter(x=>x!=null).sort((a,b)=>a-b);
    const p10=means.length?means[Math.floor(means.length*0.1)]:null;
    const w=[],s=[];
    months.forEach((ym,i)=>{ const gm=medByMonth[i]; if(gm!=null){ if(isWinter(ym))w.push(gm); if(isSummer(ym))s.push(gm); }});
    const wsRatio=(w.length>=2&&s.length>=2&&median(s)>0)?median(w)/median(s):null;
    const medByDay = days ? days.map((_,i)=>median(arr.map(m=>m.daily?m.daily[i]:null))) : null;
    // «живая группа» для D1 — медиана по дню только среди не мёртвых ПУ: иначе на дачных ТП
    // (половина ПУ нулевые) медиана всей группы ≤ EPS_D каждый день и D1 не срабатывает никогда
    const aliveArr = arr.filter(m=>{ const k=m.values.filter(x=>x!=null); return k.length>0 && !k.every(x=>x<=EPS); });
    const medByDayAlive = days ? days.map((_,i)=>median(aliveArr.map(m=>m.daily?m.daily[i]:null))) : null;
    return {medByMonth, medByDay, medByDayAlive, groupMedian:median(means), p10, wsRatio, cnt:arr.length};
  };
  const groupStats={};
  for(const [g,arr] of Object.entries(groups)) groupStats[g]=buildStats(arr);
  // подгруппы по типу потребителя (юр/физ): внутри ТП и по всему файлу.
  // Групповые признаки (S5, S8, S9, поправки S3/S14) сравнивают ПУ со «своими»:
  // юр — с юр, физ — с физ, если таких набирается от 6; иначе прежняя логика.
  const typeStats={};
  for(const [g,arr] of Object.entries(groups)){
    for(const t of ['ul','fl']){
      const sub=arr.filter(m=>m.ctype===t);
      if(sub.length>=6) typeStats[g+'|'+t]=buildStats(sub);
    }
  }
  const globalTypeStats={};
  for(const t of ['ul','fl']){
    const sub=meters.filter(m=>m.ctype===t);
    if(sub.length>=6) globalTypeStats[t]=buildStats(sub);
  }
  // маленькие группы по ТП (< 6 ПУ) сравниваем со всем файлом
  const globalStats = buildStats(meters);
  let fallbackUsed=false, typeSplitUsed=false;
  const effStats = m => {
    const g=m.tp||'__all__';
    const ts=m.ctype ? typeStats[g+'|'+m.ctype] : null;
    if(ts){ typeSplitUsed=true; return ts; }
    const gs=groupStats[g];
    const small = gs.cnt<6 && meters.length!==gs.cnt;
    if(small){
      fallbackUsed=true;
      const gt=m.ctype ? globalTypeStats[m.ctype] : null;
      if(gt){ typeSplitUsed=true; return gt; }
      return globalStats;
    }
    return gs;
  };

  // небаланс, если есть строки отпуска. НЕСКОЛЬКО строк отпуска одной группы
  // (два и более тех. учёта: Т1 + Т2 …) суммируются в ОДИН ввод помесячно;
  // месяц анализируется, только если данные есть по КАЖДОМУ вводу группы.
  const imbalanceByGroup={};
  const imbDailyByGroup={};
  const tpBalance=[];
  const supplyByGroup={};
  for(const s of supplyRows){
    // сопоставляем строку отпуска с группой ПУ: точный ключ → без регистра →
    // имя группы внутри label (берём длиннейшее, чтобы «ТП-1» не съел «ТП-10») →
    // вся выборка (с предупреждением, если групп несколько)
    let g=s.tp||'__all__', balNote=null;
    if(!groups[g]){
      const lk=String(s.idsText||s.label||'').toLowerCase(), gl=String(g).toLowerCase();
      const keys=Object.keys(groups);
      const hit=keys.find(k=>k.toLowerCase()===gl)
        || keys.filter(k=>k!=='__all__' && lk.includes(k.toLowerCase()))
             .sort((a,b)=>b.length-a.length)[0];
      if(hit) g=hit;
      else{
        g='__all__';
        if(keys.length>1 && !groups['__all__']) balNote='ТП строки отпуска не сопоставлен с ТП приборов — баланс этой строки считается по ВСЕЙ выборке ('+keys.length+' групп). Проверьте ячейку «ТП» в строке отпуска.';
      }
    }
    // номера ПУ тех. учёта: любые 6–18-значные числа в тексте строки отпуска
    // номера ПУ тех. учёта — 6–18-значные числа из служебных ячеек строки; номера,
    // совпадающие с потребителями, отбрасываем (это не ввод)
    const meterIdSet=new Set(meters.map(m=>m.id));
    const ids=(String(s.idsText||s.label||'').match(/\d{6,18}/g)||[]).filter(x=>!meterIdSet.has(x));
    (supplyByGroup[g]=supplyByGroup[g]||{rows:[], note:null}).rows.push({label:s.label.trim(), ids, values:s.values, daily:s.daily||null});
    if(balNote) supplyByGroup[g].note=balNote;
  }
  for(const g of Object.keys(supplyByGroup)){
    const rows=supplyByGroup[g].rows;
    // сумма вводов: месяц известен, только если известен у каждого ввода
    const supVals=months.map((_,i)=>{
      let sum=0;
      for(const r of rows){ if(r.values[i]==null) return null; sum+=r.values[i]; }
      return sum;
    });
    const arr=groups[g]||meters;
    const sumBy=months.map((_,i)=>{ const vv=arr.map(m=>m.values[i]).filter(x=>x!=null); return vv.length?vv.reduce((a,b)=>a+b,0):null; });
    const imb=months.map((_,i)=>(supVals[i]!=null&&sumBy[i]!=null)?supVals[i]-sumBy[i]:null);
    imbalanceByGroup[g]=imb;
    // агрегаты плашки — только по месяцам, где известны ОБЕ стороны (отпуск и ПУ),
    // чтобы всегда выполнялось: отпуск − по ПУ = разница
    let sup=0, useSum=0;
    months.forEach((_,i)=>{ if(imb[i]!=null){ sup+=supVals[i]; useSum+=sumBy[i]; } });
    const it=sup-useSum;
    const allIds=[]; rows.forEach(r=>r.ids.forEach(id=>{ if(!allIds.includes(id)) allIds.push(id); }));
    const label = rows.length===1
      ? (g!=='__all__' && !rows[0].label.toLowerCase().includes(g.toLowerCase()) ? rows[0].label+' '+g : rows[0].label)
      : 'Отпуск в сеть '+(g==='__all__'?'':g+' ')+'— сумма '+rows.length+' вводов (тех. учёт)';
    // суточный баланс (если выгрузка суточная): та же логика, но по дням
    let daily=null;
    if(days){
      const dSup=days.map((_,i)=>{ let sum=0; for(const r of rows){ if(!r.daily||r.daily[i]==null) return null; sum+=r.daily[i]; } return sum; });
      const dUse=days.map((_,i)=>{ const vv=arr.map(m=>m.daily?m.daily[i]:null).filter(x=>x!=null); return vv.length?vv.reduce((a,b)=>a+b,0):null; });
      const dImb=days.map((_,i)=>(dSup[i]!=null&&dUse[i]!=null)?dSup[i]-dUse[i]:null);
      daily={supplySeries:dSup, usefulSeries:dUse, series:dImb};
      imbDailyByGroup[g]=dImb;
    }
    tpBalance.push({group:g==='__all__'?'вся выборка':g, key:g, note:supplyByGroup[g].note, label,
      inputs:rows.map(r=>({label:r.label, ids:r.ids})), meterIds:allIds, inputCount:rows.length,
      supply:sup, sumMeters:useSum, imbalance:it, pct:sup>0?it/sup*100:null,
      series:imb, supplySeries:supVals, usefulSeries:sumBy, daily});
  }

  const results = meters.map(m=>{
    const g=m.tp||'__all__', gs=effStats(m), v=m.values;
    const known=v.filter(x=>x!=null);
    const total=known.reduce((a,b)=>a+b,0);
    // «нулевой ряд»: в суточном режиме — по суткам полных месяцев (месяц с дырами АСКУЭ даёт null
    // в месячной сумме, но живой ПУ не должен из-за этого терять признаки, в т.ч. суточные D1–D3)
    const isDead = (days && m.daily)
      ? m.daily.reduce((acc,x)=>acc+(x||0),0)<=EPS   // по всем известным суткам, включая неполные месяцы
      : (known.length===0 || known.every(x=>x<=EPS));

    const flags=[];
    let shiftIdx=null, baseline=null, loss=0, lossSrc=null;
    const add=(key,r)=>{ if(r){
      const pf = TUNE[key] ? TUNE[key].ptsF : 1; // калибровка: вес признака
      flags.push({...ALG_META[key], ...r, pts:Math.max(1,Math.round(r.pts*pf))});
      if(r.shiftIdx!=null&&shiftIdx==null){shiftIdx=r.shiftIdx; baseline=r.base;}
      if(r.loss && r.loss>loss){ loss=r.loss; lossSrc={key, base:r.base, shiftIdx:r.shiftIdx, endIdx:r.endIdx, dBase:r.dBase}; }
    } };
    const dayHits=[]; // «подозрительные» сутки от D1/D2/D3 — для суточной раскладки недоучёта

    if(!isDead && known.length){
      const s1=ALG_OFF.sleeper?null:algSleeper(v,months);
      add('sleeper',s1);
      const s2=(s1||ALG_OFF.ragged)?null:algRagged(v,months);
      add('ragged',s2);
      const s3=ALG_OFF.step?null:algStepDrop(v,months,gs.medByMonth,gs.cnt);
      add('step',s3);
      if(!s1&&!s2&&(!s3||s3.pts<=22)&&!ALG_OFF.valley) add('valley',algValley(v,months));
      if(!s1&&!s2&&!s3&&!ALG_OFF.fade) add('fade',algFade(v,months));
      if(!s1&&!s2&&!ALG_OFF.stepup){ add('stepup',algStepUp(v,months)); }
      if(!ALG_OFF.slow) add('slow',algSlowDecline(v,months,gs.medByMonth,gs.cnt,s3?s3.pts:0));
      if(!s1&&!s2&&!s3&&!ALG_OFF.lone) add('lone',algLoneSpike(v));
      if(!ALG_OFF.zeroAlive) add('zeroAlive',algZeroAlive(v,months,gs.medByMonth));
      if(!ALG_OFF.frozen) add('frozen',algFrozen(v));
      if(!ALG_OFF.round) add('round',algRound(v));
      if(!ALG_OFF.peers) add('peers',algBelowPeers(v,gs));
      if(!ALG_OFF.season) add('season',algSeason(v,months,gs.wsRatio));
      if(!ALG_OFF.idle) add('idle',algIdlePower(v,m.power));
      if(!ALG_OFF.imb) add('imb',algImbalance(v,imbalanceByGroup[g],months));
    }
    // суточные признаки — только на суточной выгрузке (в т.ч. для ПУ, у которого есть сутки, но нет ни одного полного месяца)
    if(!isDead && days && m.daily){
      const d1=ALG_OFF.dzero?null:algDayZero(m.daily, gs.medByDayAlive); add('dzero',d1);
      // D2 не считает дни, уже засчитанные D1 (нулевые сутки), — одно событие не должно набирать баллы дважды
      const d2=ALG_OFF.ddip?null:algDayDip(m.daily, d1?d1.dayIdx:null); add('ddip',d2);
      const d3=ALG_OFF.dsync?null:algDaySync(m.daily, imbDailyByGroup[g]||null); add('dsync',d3);
      [d1,d2,d3].forEach(dd=>{ if(dd&&dd.dayIdx) dd.dayIdx.forEach(i=>{ if(!dayHits.includes(i)) dayHits.push(i); }); });
    }

    let score=Math.min(100,Math.round(flags.reduce((s,f)=>s+f.pts,0)));
    if(flags.length && flags.every(f=>f.weak)) score=Math.min(score,15);
    if(baseline==null) baseline=median(known.filter(x=>x>EPS));

    let winterZeros=0;
    v.forEach((x,i)=>{ if(x!=null&&x<=EPS&&isWinter(months[i])) winterZeros++; });
    let lossR=Math.round(loss);

    // помесячная оценка недоучёта (вкладка «Баланс»): строится в окне ТОГО
    // алгоритма, который дал итоговую оценку lossKwh (S13/S1 — до точки перелома,
    // S3 — после, S3б — внутри провала), и нормируется к lossKwh
    let deficitSeries=null;
    if(lossR>0){
      let raw=null;
      if(lossSrc && lossSrc.base>0 && lossSrc.shiftIdx!=null){
        const lk=lossSrc.key, lb=lossSrc.base, lt=lossSrc.shiftIdx, le=lossSrc.endIdx;
        const inWin=i=> lk==='valley' ? (i>=lt && (le==null||i<le))
                     : lk==='step' ? i>=lt
                     : (lk==='stepup'||lk==='sleeper') ? i<lt : true;
        raw=v.map((x,i)=>(x!=null&&inWin(i))?Math.max(0,lb-x):0);
      }
      if(!raw && baseline!=null && baseline>0){
        raw=v.map(x=>x!=null?Math.max(0,baseline-x):0);
      }
      if(raw){
        const rs=raw.reduce((a,b)=>a+b,0);
        if(rs>0){ const k=lossR/rs; deficitSeries=raw.map(x=>x*k); }
      }
    }

    const band = powerBand(m.power, m.voltage);
    let capClippedKwh = 0;
    // суточная НАТИВНАЯ оценка: источник итоговой оценки — суточный признак (D1–D3)
    // либо месячной раскладки нет вовсе (короткая выгрузка). Недостача до суточной
    // базы в подозрительные дни, нормирована к lossKwh, срезана суточным потолком мощности,
    // месячный ряд — суммы по дням.
    let dailyDeficit=null, dailyNative=false, deficitPartial=0;
    // суточная база ПУ — та же формула, что в D1–D3 и тепловой карте (медиана активных суток)
    const dBase = (days && m.daily) ? ((lossSrc&&lossSrc.dBase>0)?lossSrc.dBase:(median(m.daily.filter(x=>x!=null&&x>EPS_D))||null)) : null;
    if(days && m.daily && lossR>0 && ((lossSrc && /^d/.test(lossSrc.key)) || (!deficitSeries && dayHits.length))){
      const dv=m.daily;
      const hit=new Set(dayHits);
      let raw=dv.map((x,i)=>(x!=null && (hit.size?hit.has(i):true))?Math.max(0,(dBase||0)-x):0);
      let rs=raw.reduce((a,b)=>a+b,0);
      if(rs>0){
        const k=lossR/rs;
        dailyDeficit=raw.map(x=>x*k);
        if(band&&band.capKw>0){
          let clipped=0;
          dailyDeficit=dailyDeficit.map((x,i)=>{ const c=Math.min(x, Math.max(0, band.capKw*24-(dv[i]!=null?dv[i]:0))); clipped+=x-c; return c; });
          if(clipped>0.5) capClippedKwh=Math.round(clipped);
        }
        deficitSeries=months.map((_,mi)=>monthDays[mi].reduce((s,i)=>s+dailyDeficit[i],0));
        lossR=Math.round(dailyDeficit.reduce((a,b)=>a+b,0));
        // lossR — по всем дням выгрузки, deficitSeries — только по дням полных месяцев (Σ ≤ lossR)
        deficitPartial=Math.round(lossR-deficitSeries.reduce((a,b)=>a+b,0));
        dailyNative=true;
      }
    }

    // потолок по разрешённой мощности (реестр диапазонов техприсоединения):
    // максимально возможный объём месяца = верхняя граница диапазона × 730 ч;
    // недоучёт месяца не может превышать этот объём минус оплаченное (факт по ПУ)
    if(!dailyNative && band && band.capKw>0 && lossR>0){
      const capMonth = i => Math.max(0, band.capKw*HOURS_MONTH - (v[i]!=null?v[i]:0));
      if(deficitSeries){
        let clipped=0;
        deficitSeries = deficitSeries.map((x,i)=>{
          const c=Math.min(x, capMonth(i));
          clipped += x-c;
          return c;
        });
        if(clipped>0.5){
          capClippedKwh = Math.round(clipped);
          lossR = Math.round(deficitSeries.reduce((a,b)=>a+b,0));
        }
      } else {
        // ряда нет — ограничиваем итог суммой потолков по известным месяцам
        const capSum = v.reduce((a,x,i)=>a+(x!=null?capMonth(i):0),0);
        if(lossR>capSum){ capClippedKwh = Math.round(lossR-capSum); lossR = Math.round(capSum); }
      }
    }

    // суточная раскладка недоучёта (для суточного баланса): месячный объём
    // распределяется по дням месяца пропорционально суточной «недостаче»
    // max(0, база/сут − факт), при её отсутствии — поровну; сверху — суточный потолок мощности
    if(!dailyNative && days && deficitSeries && m.daily){
      dailyDeficit=days.map(()=>0);
      const dv=m.daily;
      const baseM=(lossSrc&&lossSrc.base>0)?lossSrc.base:baseline;
      months.forEach((mm,mi)=>{
        const D=deficitSeries[mi]; if(!(D>0)) return;
        const idxs=monthDays[mi]; const dim=daysInMonth(mm.y,mm.m);
        const bd=(baseM!=null&&baseM>0)?baseM/dim:null;
        let w=idxs.map(i=>{ const x=dv[i]; if(x==null) return 0; return bd!=null?Math.max(0,bd-x):1; });
        let ws=w.reduce((a,b)=>a+b,0);
        if(ws<=0){ w=idxs.map(i=>dv[i]!=null?1:0); ws=w.reduce((a,b)=>a+b,0); }
        if(ws<=0) return;
        idxs.forEach((i,k)=>{ dailyDeficit[i]=D*w[k]/ws; });
      });
      if(band&&band.capKw>0) dailyDeficit=dailyDeficit.map((x,i)=>Math.min(x, Math.max(0, band.capKw*24-(dv[i]!=null?dv[i]:0))));
    }

    // бусты приоритета (чек-боксы в Методике): поднимают балл подходящих ПУ
    const boosts=[];
    if(!isDead){
      const ctx={ctype:m.ctype, power:m.power, dup:m.dup, lossKwh:lossR, winterZeros, shiftIdx};
      for(const b of BOOST_DEFS) if(BOOSTS_ON[b.id] && b.test(ctx)) boosts.push({id:b.id, label:b.label, pts:b.pts});
    }
    const boostPts=boosts.reduce((s,b)=>s+b.pts,0);
    score=Math.min(100, score+boostPts);

    const cls = isDead?'dead'
      : MODE.zone==='loss' ? (lossR>=MODE.lossRed?'red' : lossR>=MODE.lossAmber?'amber' : 'green')
      : score>=CLS.red?'red' : score>=CLS.amber?'amber' : 'green';

    return {meter:m, flags, score, cls, shiftIdx, baseline, total:Math.round(total),
      boosts, boostPts, deficitSeries, dailyDeficit, deficitPartial, dBase, band, capClippedKwh,
      lossKwh:lossR, lossRub:tariff?Math.round(lossR*tariff):null,
      groupMedByMonth:gs.medByMonth, groupMedByDay:(gs.medByDayAlive||gs.medByDay)||null};
  });

  results.sort((a,b)=>{
    const o={red:0,amber:1,green:2,dead:3};
    if(MODE.zone==='loss') return o[a.cls]-o[b.cls] || b.lossKwh-a.lossKwh || b.score-a.score;
    return o[a.cls]-o[b.cls] || b.score-a.score || b.lossKwh-a.lossKwh;
  });
  const totals={
    meters:meters.length,
    red:results.filter(r=>r.cls==='red').length,
    amber:results.filter(r=>r.cls==='amber').length,
    dead:results.filter(r=>r.cls==='dead').length,
    lossKwh:results.reduce((s,r)=>s+r.lossKwh,0),
  };
  totals.lossRub = tariff?Math.round(totals.lossKwh*tariff):null;
  totals.boosted = results.filter(r=>r.boostPts>0).length;
  return {results, months, days, monthDays, gran:data.gran||'month', groupStats, tpBalance, totals, groupFallback:fallbackUsed, typeSplit:typeSplitUsed};
}


export { analyze, median, mean, ymLabel, fmt, EPS, ALG_META, buildTune, TUNE_DEFS, setTune, setZoneMode, setBoosts, BOOST_DEFS, setAlgOff };
