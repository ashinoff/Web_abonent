import { setTimeout as delay } from 'node:timers/promises';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
export function normalizeMapAddress(value) {
  if (typeof value !== 'string') throw failure('Укажите адрес дома.', 400);
  const address = value.replace(/\s+/g, ' ').trim();
  if (address.length < 4 || address.length > 300 || /[\x00-\x1f<>]/.test(address)) throw failure('Некорректный адрес дома.', 400);
  return address;
}
export function photonCandidates(data) {
  return (Array.isArray(data?.features) ? data.features : []).slice(0,5).flatMap(feature => {
    const p = feature.properties || {}, [lon,lat] = feature.geometry?.coordinates || [];
    if (feature.geometry?.type !== 'Point' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180 || p.countrycode && p.countrycode.toUpperCase() !== 'RU') return [];
    const text = key => typeof p[key] === 'string' ? p[key].slice(0,180) : '';
    const result = { lat,lon,house:text('housenumber'),street:text('street'),city:text('city'),district:text('district'),locality:text('locality') };
    result.label = [text('state'),result.city || result.locality || result.district,result.street || text('name'),result.house].filter(Boolean).join(', ');
    return [result];
  });
}
export function createMapGeocoder({ fetcher = globalThis.fetch, intervalMs = 1100, endpoint = process.env.MAP_GEOCODER_URL || 'https://photon.komoot.io/api/' } = {}) {
  const service = new URL(endpoint);
  if (service.protocol !== 'https:' || service.username || service.password || service.search || service.hash) throw new Error('MAP_GEOCODER_URL: требуется HTTPS-адрес Photon API без ключей и параметров.');
  const queue = [], cache = new Map(); let running = false, nextAt = 0;
  async function pump() {
    if (running) return; running = true;
    while (queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      try {
        if (cache.has(job.address)) { job.resolve(cache.get(job.address)); continue; }
        const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(job.signal ? [job.signal] : [])]);
        await delay(Math.max(0, nextAt - Date.now()), undefined, { signal });
        nextAt = Date.now() + intervalMs;
        const url = new URL(service); url.searchParams.set('q', 'Россия, ' + job.address);
        url.searchParams.set('limit','5'); url.searchParams.set('countrycode','RU');
        const response = await fetcher(url, { signal,redirect:'error',headers:{ 'User-Agent':'WebAbonent/1.0 (+https://github.com/ashinoff/Web_abonent)', 'Accept':'application/json', 'Accept-Language':'ru' } });
        if (!response.ok) throw failure(response.status === 429 ? 'Сервис карты ограничил запросы. Повторите позже.' : 'Сервис карты временно недоступен.', response.status === 429 ? 429 : 502);
        const reader = response.body.getReader(); let size = 0; const chunks = [];
        try {
          for (;;) {
            const { done,value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 65536) throw failure('Сервис карты вернул слишком большой ответ.');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const candidates = photonCandidates(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        cache.set(job.address,candidates); if (cache.size > 2000) cache.delete(cache.keys().next().value);
        job.resolve(candidates);
      } catch (error) { job.reject(error.status ? error : failure(job.signal?.aborted ? 'Поиск остановлен.' : 'Не удалось определить адрес. Повторите позже.')); }
      finally { job.cleanup(); }
    }
    running = false;
  }
  return {
    hostname:service.hostname,
    lookup(value, { signal } = {}) {
      const address = normalizeMapAddress(value);
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (cache.has(address)) return Promise.resolve(cache.get(address));
      if (queue.length >= 30) return Promise.reject(failure('Поиск адресов занят. Повторите чуть позже.',429));
      return new Promise((resolve,reject) => {
        const job = { address,resolve,reject,signal,cleanup:() => signal?.removeEventListener('abort',abort) };
        function abort() { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i,1); job.cleanup(); } reject(signal.reason); }
        signal?.addEventListener('abort',abort,{ once:true }); queue.push(job); pump();
      });
    },
  };
}
