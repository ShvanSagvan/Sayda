export class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || `HTTP ${status}`); this.status = status; this.code = body?.error; this.body = body || {}; }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'offline', message: 'No connection. Check your internet and try again.' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  // Fire-and-forget that survives page unload (progress saves).
  beacon(u, b) {
    const blob = new Blob([JSON.stringify(b)], { type: 'text/plain' });
    if (navigator.sendBeacon && navigator.sendBeacon(u, blob)) return;
    fetch(u, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  },
  // Upload with progress (fetch has no upload progress). Returns {promise, abort}.
  upload(method, url, bodyOrFile, onProgress, contentType) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open(method, url);
      xhr.withCredentials = url.startsWith('/');
      if (contentType) xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new ApiError(xhr.status, data));
      };
      xhr.onerror = () => reject(new ApiError(0, { error: 'offline', message: 'Upload failed — connection lost.' }));
      xhr.onabort = () => reject(new ApiError(0, { error: 'aborted', message: 'Upload cancelled.' }));
      xhr.send(bodyOrFile);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
