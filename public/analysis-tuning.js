import { fmt } from './analysis-engine.js';
const LEVEL_NAMES = {'-2':'намного мягче','-1':'мягче','0':'стандарт v3','1':'строже','2':'намного строже'};
const TUNE_ORDER = ['sleeper','ragged','step','valley','fade','zeroAlive','frozen','round','peers','season','idle','imb','lone','stepup','slow','dzero','ddip','dsync'];
const TUNE_HINT = {
  sleeper:  p=>'нужно ≥'+p.minZeros+' мес. нулей и уровень после «пробуждения» ≥'+p.minPost+' кВт·ч/мес',
  ragged:   p=>'всплеск ≥'+fmt(p.minSpike,1)+'× типичного, переходов «ноль↔расход» ≥'+p.minTrans,
  step:     p=>'ступень засчитывается при падении до ≤'+Math.round(p.rMax*100)+'% прежнего уровня',
  valley:   p=>'провал засчитывается при уровне ≤'+Math.round(p.rMax*100)+'% от «берегов»',
  fade:     p=>'последние месяцы ≤'+Math.round(p.rMax*100)+'% собственной базы',
  zeroAlive:p=>'от '+p.minZeros+' нулевых мес. при живом потреблении группы',
  frozen:   p=>'от '+p.minRun+' мес. одинаковых показаний, либо разброс CV ≤'+fmt(p.maxCV,1)+'%',
  round:    p=>'кратных 50 должно быть ≥'+Math.round(p.minShare*100)+'% значений',
  peers:    p=>'средний расход ниже '+Math.round(p.maxFrac*100)+'% медианы группы',
  season:   p=>'зима/лето ≤'+Math.round(p.maxOwn*100)+'% от группового отношения',
  idle:     p=>'порог «почти нет расхода» — '+p.maxAvg+' кВт·ч/мес (для крупных мощностей масштабируется)',
  imb:      p=>'корреляция провалов с небалансом ТП ≥'+fmt(p.minCorr,2),
  lone:     p=>'разовый объём от '+fmt(p.minSum)+' кВт·ч',
  stepup:   p=>'устойчивый рост уровня в ≥'+fmt(p.minJump,1)+' раза',
  slow:     p=>'падение годовых уровней до ≤'+Math.round(p.rMax*100)+'%',
  dzero:    p=>'[сутки] от '+p.minDays+' нулевых суток при живой группе',
  ddip:     p=>'[сутки] провал от '+p.minRun+' дней подряд ниже 30% суточной базы',
  dsync:    p=>'[сутки] корреляция с суточным небалансом ≥'+fmt(p.minCorr,2),
};


export { LEVEL_NAMES, TUNE_ORDER, TUNE_HINT };
