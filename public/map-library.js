let loading;
export async function loadMapLibrary() {
  if (globalThis.L) return globalThis.L;
  loading ||= import('./vendor/leaflet/leaflet.js'); await loading;
  return globalThis.L;
}
