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

  /**
   * Subida por partes de 8 MB: sirve para archivos de más de 1 GB y se reanuda sola
   * si la señal se corta (reintenta cada parte y pregunta al servidor dónde quedó).
   */
  async uploadChunked(blob, fields, onProgress) {
    const start = await req('POST', '/api/uploads', { ...fields, size: blob.size, mime: blob.type || '', name: blob.name || '' });
    const id = start.id;
    const size = start.chunkSize || 8 * 1048576;
    let offset = start.offset || 0;
    let fails = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + size, blob.size);
      try {
        const r = await putChunk(`/api/uploads/${id}?offset=${offset}`, blob.slice(offset, end), (sent) => onProgress?.((offset + sent) / blob.size));
        offset = r.offset;
        fails = 0;
      } catch (e) {
        if (e.status && e.status !== 409 && e.status < 500) throw e;
        if (++fails > 8) throw new ApiError('Se perdió la conexión. Intenta de nuevo con mejor señal.', 0);
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** fails)));
        try {
          offset = (await req('GET', `/api/uploads/${id}`)).offset;
        } catch (e2) {
          if (e2.status === 404) throw e2;
        }
      }
      onProgress?.(offset / blob.size);
    }
    return req('POST', `/api/uploads/${id}/finish`);
  },

  /** Transcribe un clip de voz corto. */
  async listen(id, blob) {
    const res = await fetch(`/api/notes/${id}/listen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Mime': blob.type || 'audio/webm' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status);
    return data.text || '';
  },

  /** Chat con eventos SSE sobre POST. */
  async chat(id, question, { onDelta, mode, day } = {}) {
    const res = await fetch(`/api/notes/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode, day }),
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

function putChunk(url, chunk, onSent) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.timeout = 5 * 60_000;
    x.upload.onprogress = (e) => onSent?.(e.loaded);
    x.onload = () => {
      let data = {};
      try {
        data = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else {
        if (x.status === 401) window.dispatchEvent(new Event('selah:logout'));
        reject(new ApiError(data.error || `Error ${x.status}`, x.status));
      }
    };
    x.onerror = x.ontimeout = () => reject(new ApiError('Sin conexión', 0));
    x.send(chunk);
  });
}
