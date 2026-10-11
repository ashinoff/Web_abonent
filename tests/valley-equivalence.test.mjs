import test from 'node:test';
import assert from 'node:assert/strict';
import { algValley, median, fmt, ymLabel, buildTune, setTune } from '../public/analysis-engine.js';

// Preserve the former detector here as an independent regression reference.
function referenceValley(v, months, TUNE){
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


test('optimized valley preserves every flag field across 3,000 histories and all tuning levels', () => {
  let seed = 0x917352;
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for (let trial = 0; trial < 3000; trial++) {
    const n = 6 + Math.floor(random()*115), base = 100 + Math.floor(random()*2000), level = trial % 5 - 2;
    const from = 3 + Math.floor(random()*Math.max(1,n-10)), length = 4 + Math.floor(random()*21);
    const values = Array.from({length:n}, (_,i) => random()<.12 ? null : i>=from && i<from+length ? Math.floor(random()*base*.25) : Math.floor(base*(.9+random()*.2)));
    if (trial%3===0) values[Math.floor(random()*n)] = 0;
    if (trial%13===0) values[Math.floor(random()*n)] = NaN;
    if (trial%29===0) values[Math.floor(random()*n)] = undefined;
    const months = values.map((_,i)=>({y:2016+Math.floor(i/12),m:i%12}));
    const levels = {valley:level}; setTune(levels);
    assert.deepEqual(algValley(values,months),referenceValley(values,months,buildTune(levels)), `history ${trial}, level ${level}`);
  }
});
