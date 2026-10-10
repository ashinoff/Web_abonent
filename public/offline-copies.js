export const sourceRoles = [['registry', 'Реестр'], ['consumption', 'ПО'], ['incoming', 'Приём']];
const name = path => path.split('/').filter(Boolean).at(-1) || path;

export function folderSources(folder) {
  if(folder.load_blocked)return [];
  return sourceRoles.flatMap(([role]) => {
    const item = folder.statuses?.[role];
    return item?.path ? [{ role, path: item.path, name: item.file || name(item.path), size: item.size, modified: item.modified }] : [];
  });
}
export function offlineCopyState(copy, files) {
  if (!copy?.files.length) return 'missing';
  if (!files.some(file => file.role === 'registry') || !files.every(file => copy.files.some(saved => saved.path === file.path && saved.role === file.role))) return 'partial';
  return copy.files.some(file => file.stale) ? 'stale' : 'ready';
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: unit ? 1 : 0 }).format(value) + ' ' + units[unit];
}
export function withLocalFolders(folders, copies) {
  const result = [...folders];
  for (const copy of copies) {
    if (result.some(folder => folder.res_path === copy.resPath)) continue;
    const enterprisePath = copy.resPath.slice(0, copy.resPath.lastIndexOf('/')) || '/';
    result.push({ res_path: copy.resPath, res_name: name(copy.resPath), enterprise_path: enterprisePath, enterprise_name: name(enterprisePath),
      localOnly: true, statuses: Object.fromEntries(copy.files.map(file => [file.role, { state: 'unknown', path: file.path, file: name(file.path) }])) });
  }
  return result;
}
export function offlineDirectory(copies, path) {
  const folders = withLocalFolders([], copies);
  if (path === '/') return folders.length ? [...new Map(folders.map(folder => [folder.enterprise_path,
    { type:'dir', path:folder.enterprise_path, name:folder.enterprise_name }])).values()] : null;
  if (folders.some(folder => folder.enterprise_path === path)) return folders.filter(folder => folder.enterprise_path === path)
    .map(folder => ({ type:'dir', path:folder.res_path, name:folder.res_name }));
  const copy = copies.find(item => item.resPath === path);
  return copy ? copy.files.map(file => ({ type:'file', path:file.path, name:name(file.path) })) : null;
}
export function rememberMapDirectories(source, folders, storage = localStorage) {
  if (!folders.length) return;
  const groups = new Map();
  for (const folder of folders) {
    if (!groups.has(folder.enterprise_path)) groups.set(folder.enterprise_path, { name: folder.enterprise_name, children: [] });
    groups.get(folder.enterprise_path).children.push({ type: 'dir', path: folder.res_path, name: folder.res_name });
  }
  const save = (path, items) => { try { storage.setItem('abonent.folder.v1:' + source + ':' + path, JSON.stringify(items)); } catch {} };
  save('/', [...groups].map(([path, group]) => ({ type: 'dir', path, name: group.name })));
  for (const [path, group] of groups) save(path, group.children);
}
export function rememberOfflineFiles(source, resPath, files, storage = localStorage) {
  const key = 'abonent.folder.v1:' + source + ':' + resPath;
  try {
    const old = JSON.parse(storage.getItem(key) || '[]');
    const items = new Map((Array.isArray(old) ? old : []).map(item => [item.path, item]));
    for (const file of files) items.set(file.path, { type: 'file', path: file.path, name: file.name || name(file.path), size: file.size, modified: file.modified });
    storage.setItem(key, JSON.stringify([...items.values()]));
  } catch { /* The data copy is still available if directory preferences are full. */ }
}
