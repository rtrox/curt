export type Route =
  | { page: 'home' } | { page: 'tokens' } | { page: 'people' } | { page: 'callback' } | { page: 'missing' }
  | { page: 'link'; id: string };

export function parsePath(path: string): Route {
  if (path === '/') return { page: 'home' };
  if (path === '/tokens') return { page: 'tokens' };
  if (path === '/people') return { page: 'people' };
  if (path === '/auth/callback') return { page: 'callback' };
  const m = /^\/links\/([^/]+)$/.exec(path);
  if (m?.[1]) {
    try { return { page: 'link', id: decodeURIComponent(m[1]) }; } catch { /* malformed escape */ }
  }
  return { page: 'missing' };
}

class Router {
  route = $state<Route>(parsePath(location.pathname));
  /** False until the first in-app navigation, so a fresh load does not move focus. */
  moved = $state(false);

  constructor() {
    addEventListener('popstate', () => { this.moved = true; this.route = parsePath(location.pathname); });
  }
  go(path: string, replace = false): void {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    this.moved = true;
    this.route = parsePath(location.pathname);
    scrollTo(0, 0);
  }
}
export const router = new Router();

/** Svelte action: plain clicks on a same-site link change the route instead of reloading. */
export function nav(node: HTMLAnchorElement) {
  const click = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.go(node.pathname);
  };
  node.addEventListener('click', click);
  return { destroy: () => node.removeEventListener('click', click) };
}
