import { validLocation } from './notes-map-data.js';

export function mapRouteLinks(location) {
  if (!validLocation(location)) return [];
  const destination=`${location.lat},${location.lon}`;
  const yandex=new URL('https://yandex.ru/maps/');
  yandex.searchParams.set('rtext','~'+destination);
  yandex.searchParams.set('rtt','auto');
  const google=new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api','1');
  google.searchParams.set('destination',destination);
  google.searchParams.set('travelmode','driving');
  return [{provider:'yandex',label:'Яндекс Карты',href:yandex.href},
    {provider:'google',label:'Google Maps',href:google.href}];
}

export function createMapRoutes(location) {
  const links=mapRouteLinks(location);
  if (!links.length) return null;
  const routes=document.createElement('section');routes.className='map-routes';
  routes.dataset.noSwipe='';routes.setAttribute('aria-label','Маршрут к отметке');
  const title=document.createElement('strong');title.textContent='Маршрут к отметке';routes.append(title);
  const coordinates=document.createElement('span');coordinates.className='map-route-coordinates';
  coordinates.textContent=`${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`;routes.append(coordinates);
  const actions=document.createElement('div');actions.className='map-route-actions';
  for (const route of links) {
    const link=document.createElement('a');link.className='map-route-link';link.dataset.routeProvider=route.provider;
    link.href=route.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=route.label;
    link.setAttribute('aria-label','Построить маршрут к отметке — '+route.label);actions.append(link);
  }
  routes.append(actions);return routes;
}
