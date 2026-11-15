export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

async function req(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) window.dispatchEvent(new Event('selah:logout'));
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),

  /** Subida con progreso (fetch no informa progreso de envío). */
  upload(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let data = {};
        try {
          data = JSON.parse(x.responseText);
        } catch {}
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new ApiError(data.error || `Error ${x.status}`, x.status));
      };
      x.onerror = () => reject(new ApiError('Sin conexión. Intenta de nuevo.', 0));
      x.send(form);
    });
  },

  /** Chat con eventos SSE sobre POST. */
  async chat(id, question, { onDelta }) {
    const res = await fetch(`/api/notes/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new ApiError(d.error || 'Error del asistente', res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] || '{}');
        if (ev === 'delta') onDelta?.(data.text);
        if (ev === 'done') final = data.text;
        if (ev === 'error') throw new ApiError(data.error, 500);
      }
    }
    return final;
  },
};
