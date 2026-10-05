const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
const part = value => norm(value).replace(/(?:^|\s)(?:г|город|пос|поселок|п|с|село|ст|станица|ул|улица|проспект|пр-кт|пер|переулок|д|дом|корп|корпус)(?:\.|(?=\s|$))\s*/g, ' ').replace(/[^\p{L}\p{N}]/gu, '');

export function validLocation(value) {
  return Boolean(value && typeof value.lat === 'number' && typeof value.lon === 'number' && Number.isFinite(value.lat) && Number.isFinite(value.lon) && Math.abs(value.lat) <= 85 && Math.abs(value.lon) <= 180);
}
export function registryLocation(fields = {}) {
  if (!clean(fields.latitude) || !clean(fields.longitude)) return null;
  const value = { lat:Number(String(fields.latitude).replace(',', '.')), lon:Number(String(fields.longitude).replace(',', '.')), precision:'registry' };
  return validLocation(value) ? value : null;
}
// Apartment numbers and subscriber details never enter a geocoding request.
export function mapAddress(note) {
  const f = note.fields || {};
  const structured = [f.locality, f.street, f.house && `д. ${f.house}`, f.building && `корп. ${f.building}`].filter(Boolean).join(', ');
  return clean(structured || note.address).replace(/(?:,?\s*(?:квартира|кв\.?|офис|помещение|пом\.)\s*[^,;]*)/giu, '').trim();
}
export function groupMapNotes(notes) {
  const groups = new Map();
  for (const note of notes) {
    const address = mapAddress(note), key = note.type === 'user' ? `user:${note.id}` : address ? norm(address) : `missing:${note.id}`;
    if (!groups.has(key)) groups.set(key, { key, address, notes:[], location:null, candidates:[], state:address ? 'pending' : 'no_address' });
    const group = groups.get(key); group.notes.push(note);
    const location = note.type === 'user' && validLocation(note.location) ? note.location : registryLocation(note.fields);
    if (location && !group.location) { group.location = location; group.state = 'ready'; }
  }
  return [...groups.values()];
}
export function exactCandidate(group, candidates) {
  const f = group.notes[0]?.fields || {};
  if (!f.locality || !f.street || !f.house) return null;
  const house = part(f.house + (f.building || ''));
  const matches = candidates.filter(candidate => validLocation(candidate) && part(candidate.house) === house && part(candidate.street) === part(f.street)
    && [candidate.city,candidate.district,candidate.locality].some(value => part(value) === part(f.locality)));
  const unique = [...new Map(matches.map(value => [`${value.lat.toFixed(5)},${value.lon.toFixed(5)}`, value])).values()];
  return unique.length === 1 ? { ...unique[0], precision:'address' } : null;
}
export function mapNoteMatches(note, query) {
  const f = note.fields || {};
  return norm([note.note,note.address,f.name,f.meter,f.account,f.tp,f.point,f.pointNumber,f.pointName].filter(Boolean).join(' ')).includes(norm(query));
}
export function visibleMapGroups(groups, query, origin = 'all') {
  return groups.map(group => ({ ...group, notes:group.notes.filter(note => mapNoteMatches(note, query) && (origin === 'all' || (note.type === 'user' ? 'user' : 'registry') === origin)) })).filter(group => group.notes.length);
}

const storageKey = 'abonent.map-locations.v1';
export function readMapLocations(scope, storage = globalThis.localStorage) {
  try {
    const items = JSON.parse(storage.getItem(storageKey) || '[]');
    if (!Array.isArray(items)) return new Map();
    return new Map(items.filter(item => item.scope === scope && typeof item.key === 'string' && validLocation(item.location)).map(item => [item.key,item.location]));
  } catch { return new Map(); }
}
export function saveMapLocation(scope, key, location, storage = globalThis.localStorage) {
  if (!validLocation(location)) return false;
  try {
    let items;
    try { items = JSON.parse(storage.getItem(storageKey) || '[]'); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    items = items.filter(item => !(item.scope === scope && item.key === key));
    items.push({ scope,key,location:{ lat:location.lat,lon:location.lon,precision:location.precision || 'manual' } });
    storage.setItem(storageKey, JSON.stringify(items.slice(-1000))); return true;
  } catch { return false; }
}
