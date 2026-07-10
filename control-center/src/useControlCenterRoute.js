import { useCallback, useEffect, useState } from 'react';

export const CONTROL_CENTER_PAGES = Object.freeze(['confirm', 'running', 'settings']);
export const CONTROL_CENTER_VIEWS = Object.freeze(['list', 'new', 'work']);

export function normalizeControlCenterRoute(input = {}) {
  const requestedPage = String(input.page ?? '').trim();
  const page = CONTROL_CENTER_PAGES.includes(requestedPage) ? requestedPage : 'confirm';
  const requestedView = String(input.view ?? '').trim();
  let view = CONTROL_CENTER_VIEWS.includes(requestedView) ? requestedView : 'list';
  if (page === 'settings') view = 'list';
  if (page === 'running' && view === 'new') view = 'list';
  const rawItemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  const itemId = view === 'work' && rawItemId ? rawItemId : null;
  return Object.freeze({ page, view, itemId });
}

export function parseControlCenterRoute(search = '') {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  return normalizeControlCenterRoute({
    page: params.get('page'),
    view: params.get('view'),
    itemId: params.get('item')
  });
}

export function controlCenterRouteUrl(route, locationLike = globalThis.location) {
  const normalized = normalizeControlCenterRoute(route);
  const pathname = locationLike?.pathname || '/';
  const hash = locationLike?.hash || '';
  const params = new URLSearchParams();
  if (normalized.page !== 'confirm') params.set('page', normalized.page);
  if (normalized.view !== 'list') params.set('view', normalized.view);
  if (normalized.itemId) params.set('item', normalized.itemId);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

export function useControlCenterRoute() {
  const [route, setRoute] = useState(readBrowserRoute);

  useEffect(() => {
    const handlePopState = () => setRoute(readBrowserRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((nextRoute, options = {}) => {
    const normalized = normalizeControlCenterRoute(nextRoute);
    const url = controlCenterRouteUrl(normalized, window.location);
    if (options.replace === true) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setRoute(normalized);
    return normalized;
  }, []);

  const back = useCallback(() => {
    window.history.back();
  }, []);

  return { route, navigate, back };
}

function readBrowserRoute() {
  if (typeof window === 'undefined') return normalizeControlCenterRoute();
  return parseControlCenterRoute(window.location.search);
}
