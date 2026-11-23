export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), del: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
        const params = {};
        try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); }
        catch { return { badRequest: true }; }
        return { handler: r.handler, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}
