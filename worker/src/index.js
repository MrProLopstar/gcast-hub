const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, content-type, x-hub-key',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges',
};
const TAG = 'videos';
const LICENSES = ['CC0', 'CC-BY', 'CC-BY-SA', 'CC-BY-NC', 'public-domain', 'own'];
const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ_-';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });

const github = (env, path, init = {}) =>
  fetch(path.startsWith('https://') ? path : `https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'gcast-hub', ...init.headers },
  });

const release = async (env) => {
  const found = await github(env, `/releases/tags/${TAG}`);
  if (found.ok) return found.json();
  const created = await github(env, '/releases', { method: 'POST', body: JSON.stringify({ tag_name: TAG, name: 'Videos', body: 'Files of the gcast hub. Watch them at the hub site.' }) });
  if (!created.ok) throw new Error(`Cannot create the release: ${created.status}`);
  return created.json();
};

const upload = async (env, name, body, type, size) => {
  const { upload_url: url } = await release(env);
  const sized = new FixedLengthStream(size);
  body.pipeTo(sized.writable);
  const response = await github(env, url.replace('{?name,label}', `?name=${encodeURIComponent(name)}`), { method: 'POST', body: sized.readable, headers: { 'content-type': type, 'content-length': String(size) } });
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
};

const catalog = async (env, change) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await github(env, '/contents/videos.json');
    const file = current.ok ? await current.json() : null;
    const videos = file ? JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))))) : [];
    const next = change(videos);
    const saved = await github(env, '/contents/videos.json', {
      method: 'PUT',
      body: JSON.stringify({ message: 'Update the catalog', content: btoa(unescape(encodeURIComponent(`${JSON.stringify(next, null, 2)}\n`))), ...(file ? { sha: file.sha } : {}) }),
    });
    if (saved.ok) return next;
    if (saved.status !== 409) throw new Error(`Cannot save the catalog: ${saved.status}`);
  }
  throw new Error('The catalog is busy, try again');
};

const describe = (head) => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 20 || view.getUint32(0, true) !== 0x54534347) throw new Error('This is not a .gcast file');
  const fps = view.getFloat32(10, true);
  return { cols: view.getUint16(6, true), rows: view.getUint16(8, true), fps, duration: Math.round((view.getUint32(16, true) / fps) * 10) / 10 };
};

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);

const PART = 90 * 1048576;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(11)), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
const allowed = (request, env) => Boolean(env.HUB_KEY) && request.headers.get('x-hub-key') === env.HUB_KEY;

const asset = (env, name, range) =>
  fetch(`https://github.com/${env.REPO}/releases/download/${TAG}/${encodeURIComponent(name)}`, {
    headers: { 'user-agent': 'gcast-hub', ...(range ? { range } : {}) },
    redirect: 'follow',
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });

const fields = (url) => {
  const title = (url.searchParams.get('title') ?? '').trim().slice(0, 120);
  const license = url.searchParams.get('license') ?? 'own';
  const listed = url.searchParams.get('listed') === '1';
  if (!title) return { error: 'A title is needed' };
  if (!LICENSES.includes(license)) return { error: `License must be one of ${LICENSES.join(', ')}` };
  if (listed && license === 'own') return { error: 'Only openly licensed videos can be listed; choose a license or keep it unlisted' };
  return { title, license, listed };
};

const hidden = (env) => env.INDEX.get(env.INDEX.idFromName('unlisted'));

const keepHidden = (env, entry) => hidden(env).fetch('https://index/put', { method: 'POST', body: JSON.stringify(entry) });

const remember = async (env, entry) => {
  if (entry.listed) await catalog(env, (videos) => {
    const taken = new Set(videos.map((video) => video.slug));
    if (taken.has(entry.slug)) entry.slug = `${entry.slug}-${entry.id.slice(0, 4)}`;
    return [entry, ...videos];
  });
  else await keepHidden(env, entry);
  return json(entry, 201);
};

const readCatalog = async (env) => {
  const current = await github(env, '/contents/videos.json');
  if (!current.ok) return [];
  const file = await current.json();
  return JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, '')))));
};

const adminList = async (env) => {
  const [listed, unlisted, assets] = await Promise.all([
    readCatalog(env),
    hidden(env).fetch('https://index/list').then((response) => response.json()),
    release(env).then((found) => found.assets ?? []),
  ]);
  const known = new Set([...listed, ...unlisted].map((video) => video.id));
  const files = new Map();
  for (const item of assets) {
    const id = item.name.slice(0, 11);
    files.set(id, (files.get(id) ?? 0) + (/\.gcast(\.\d+)?$/.test(item.name) ? item.size : 0));
  }
  const orphans = [...files].filter(([id, size]) => !known.has(id) && size > 0).map(([id, size]) => ({ id, slug: id, title: '', license: 'own', listed: false, size, orphan: true }));
  return json({ videos: [...listed, ...unlisted, ...orphans].map((video) => ({ ...video, files: files.get(video.id) ?? 0 })) });
};

const adminUpdate = async (request, env, id) => {
  const change = await request.json();
  const listed = await readCatalog(env);
  const unlisted = await hidden(env).fetch('https://index/list').then((response) => response.json());
  let entry = listed.find((video) => video.id === id) ?? unlisted.find((video) => video.id === id);
  if (!entry) {
    const head = await asset(env, `${id}.gcast`, 'bytes=0-19');
    const first = head.ok ? head : await asset(env, `${id}.gcast.0`, 'bytes=0-19');
    if (!first.ok) return json({ error: 'No such video' }, 404);
    entry = { id, slug: id, title: id, license: 'own', listed: false, size: 0, ...describe(new Uint8Array(await first.arrayBuffer())), poster: false, added: new Date().toISOString().slice(0, 10) };
  }
  const title = typeof change.title === 'string' && change.title.trim() ? change.title.trim().slice(0, 120) : entry.title;
  const license = typeof change.license === 'string' && LICENSES.includes(change.license) ? change.license : entry.license;
  const wantsListed = typeof change.listed === 'boolean' ? change.listed : entry.listed;
  if (wantsListed && license === 'own') return json({ error: 'Only openly licensed videos can be listed' }, 400);
  const next = { ...entry, title, license, listed: wantsListed, slug: entry.listed === wantsListed && entry.title === title ? entry.slug : slugify(title) || id };
  await catalog(env, (videos) => {
    const others = videos.filter((video) => video.id !== id);
    if (!wantsListed) return others;
    const taken = new Set(others.map((video) => video.slug));
    if (taken.has(next.slug)) next.slug = `${next.slug}-${id.slice(0, 4)}`;
    const at = videos.findIndex((video) => video.id === id);
    if (at < 0) return [next, ...others];
    return videos.map((video) => (video.id === id ? next : video));
  });
  if (wantsListed) await hidden(env).fetch(`https://index/delete?id=${id}`, { method: 'POST' });
  else await keepHidden(env, next);
  return json(next);
};

const adminDelete = async (env, id) => {
  const found = await release(env);
  for (const item of found.assets ?? []) if (item.name.startsWith(`${id}.`)) await github(env, `/releases/assets/${item.id}`, { method: 'DELETE' });
  await catalog(env, (videos) => videos.filter((video) => video.id !== id));
  await hidden(env).fetch(`https://index/delete?id=${id}`, { method: 'POST' });
  return json({ ok: true });
};

export class Index {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/list') return Response.json([...(await this.storage.list({ prefix: 'video:' })).values()]);
    if (url.pathname === '/put') {
      const entry = await request.json();
      await this.storage.put(`video:${entry.id}`, entry);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/patch') {
      const key = `video:${url.searchParams.get('id')}`;
      const entry = await this.storage.get(key);
      if (entry) await this.storage.put(key, { ...entry, ...(await request.json()) });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/delete') {
      await this.storage.delete(`video:${url.searchParams.get('id')}`);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }
}

const partUpload = async (request, env, id, index) => {
  if (!allowed(request, env)) return json({ error: 'Wrong upload key' }, 403);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size || size > PART) return json({ error: `A part must be from 1 byte to ${PART} bytes` }, 400);
  await upload(env, `${id}.gcast.${index}`, request.body, 'application/octet-stream', size);
  return json({ ok: true });
};

const partFinish = async (request, env, id, url) => {
  if (!allowed(request, env)) return json({ error: 'Wrong upload key' }, 403);
  const given = fields(url);
  if (given.error) return json(given, 400);
  const sizes = (url.searchParams.get('sizes') ?? '').split(',').map(Number).filter((size) => size > 0);
  if (sizes.length === 0) return json({ error: 'Part sizes are needed' }, 400);
  const head = await asset(env, `${id}.gcast.0`, 'bytes=0-19');
  if (!head.ok) return json({ error: 'The first part is missing' }, 400);
  const info = describe(new Uint8Array(await head.arrayBuffer()));
  const manifest = new TextEncoder().encode(JSON.stringify({ sizes }));
  await upload(env, `${id}.parts`, new Blob([manifest]).stream(), 'application/json', manifest.length);
  const size = sizes.reduce((sum, part) => sum + part, 0);
  return remember(env, { id, slug: slugify(given.title) || id, ...given, size, ...info, poster: false, added: new Date().toISOString().slice(0, 10) });
};

const stitched = async (request, env, id) => {
  const manifest = await asset(env, `${id}.parts`);
  if (!manifest.ok) return null;
  const { sizes } = await manifest.json();
  const total = sizes.reduce((sum, part) => sum + part, 0);
  const wanted = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  let start = 0;
  let end = total - 1;
  if (wanted) {
    if (!wanted[1] && wanted[2]) start = Math.max(0, total - Number(wanted[2]));
    else {
      start = Number(wanted[1] || 0);
      if (wanted[2]) end = Math.min(total - 1, Number(wanted[2]));
    }
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { ...CORS, 'content-range': `bytes */${total}` } });
  }
  const headers = { ...CORS, 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'cache-control': 'public, max-age=86400' };
  if (wanted) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  if (request.method === 'HEAD') return new Response(null, { status: wanted ? 206 : 200, headers });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const pump = async () => {
    let offset = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const from = Math.max(start, offset);
      const to = Math.min(end, offset + sizes[index] - 1);
      if (from <= to) {
        // GitHub sometimes ends a response early without an error, so keep asking for the rest of the range
        for (let at = from, tries = 0; at <= to; ) {
          if ((tries += 1) > 8) throw new Error(`Part ${index} keeps breaking off`);
          const part = await asset(env, `${id}.gcast.${index}`, `bytes=${at - offset}-${to - offset}`);
          if (part.status !== 206 || !part.body) throw new Error(`Part ${index}: HTTP ${part.status}`);
          const reader = part.body.getReader();
          for (;;) {
            const { done, value } = await reader.read().catch(() => ({ done: true }));
            if (done) break;
            await writer.write(value);
            at += value.length;
          }
        }
      }
      offset += sizes[index];
    }
    await writer.close();
  };
  pump().catch((error) => writer.abort(error).catch(() => undefined));
  return new Response(readable, { status: wanted ? 206 : 200, headers });
};

const publish = async (request, env, url) => {
  if (!env.HUB_KEY || request.headers.get('x-hub-key') !== env.HUB_KEY) return json({ error: 'Wrong upload key' }, 403);
  const title = (url.searchParams.get('title') ?? '').trim().slice(0, 120);
  const license = url.searchParams.get('license') ?? 'own';
  const listed = url.searchParams.get('listed') === '1';
  if (!title) return json({ error: 'A title is needed' }, 400);
  if (!LICENSES.includes(license)) return json({ error: `License must be one of ${LICENSES.join(', ')}` }, 400);
  if (listed && license === 'own') return json({ error: 'Only openly licensed videos can be listed; choose a license or keep it unlisted' }, 400);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size) return json({ error: 'Send the file with a content-length' }, 411);
  const [peek, body] = request.body.tee();
  const reader = peek.getReader();
  const first = await reader.read();
  reader.cancel();
  const info = describe(first.value ?? new Uint8Array());
  const id = Array.from(crypto.getRandomValues(new Uint8Array(11)), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  await upload(env, `${id}.gcast`, body, 'application/octet-stream', size);
  const entry = { id, slug: slugify(title) || id, title, license, listed, size, ...info, poster: false, added: new Date().toISOString().slice(0, 10) };
  return remember(env, entry);
};

const poster = async (request, env, id) => {
  if (!env.HUB_KEY || request.headers.get('x-hub-key') !== env.HUB_KEY) return json({ error: 'Wrong upload key' }, 403);
  await upload(env, `${id}.jpg`, request.body, 'image/jpeg', Number(request.headers.get('content-length') ?? 0));
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, poster: true } : video)));
  await hidden(env).fetch(`https://index/patch?id=${id}`, { method: 'POST', body: JSON.stringify({ poster: true }) });
  return json({ ok: true });
};

const variant = async (request, env, id, url) => {
  if (!allowed(request, env)) return json({ error: 'Wrong upload key' }, 403);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size || size > PART) return json({ error: `A variant must be from 1 byte to ${PART} bytes` }, 400);
  const [peek, body] = request.body.tee();
  const reader = peek.getReader();
  const first = await reader.read();
  reader.cancel();
  const { cols } = describe(first.value ?? new Uint8Array());
  await upload(env, `${id}-${cols}.gcast`, body, 'application/octet-stream', size);
  const add = (video) => (video.id === id ? { ...video, variants: [...new Set([...(video.variants ?? []), cols])].sort((a, b) => a - b) } : video);
  await catalog(env, (videos) => videos.map(add));
  const unlisted = await hidden(env).fetch('https://index/list').then((response) => response.json());
  const entry = unlisted.find((video) => video.id === id);
  if (entry) await keepHidden(env, add(entry));
  return json({ ok: true, cols });
};

const subtitles = async (request, env, id) => {
  if (!env.HUB_KEY || request.headers.get('x-hub-key') !== env.HUB_KEY) return json({ error: 'Wrong upload key' }, 403);
  await upload(env, `${id}.vtt`, request.body, 'text/vtt; charset=utf-8', Number(request.headers.get('content-length') ?? 0));
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, subtitles: true } : video)));
  await hidden(env).fetch(`https://index/patch?id=${id}`, { method: 'POST', body: JSON.stringify({ subtitles: true }) });
  return json({ ok: true });
};

const TYPES = { jpg: 'image/jpeg', vtt: 'text/vtt; charset=utf-8', gcast: 'application/octet-stream' };

const serveFile = async (request, env, name) => {
  const headers = new Headers({ 'user-agent': 'gcast-hub' });
  const range = request.headers.get('range');
  if (range) headers.set('range', range);
  const upstream = await fetch(`https://github.com/${env.REPO}/releases/download/${TAG}/${encodeURIComponent(name)}`, { headers, redirect: 'follow', cf: { cacheEverything: true, cacheTtl: 86400 } });
  if (upstream.status === 404 && name.endsWith('.gcast')) {
    const parts = await stitched(request, env, name.slice(0, -6));
    if (parts) return parts;
  }
  const out = new Headers(CORS);
  for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  out.set('content-type', TYPES[name.split('.').pop()] ?? 'application/octet-stream');
  out.set('cache-control', 'public, max-age=86400');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
};

export class Room {
  constructor() {
    this.header = null;
    this.latest = null;
    this.viewers = new Set();
  }

  async fetch(request) {
    if (request.headers.get('upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      try {
        this.socket?.close(1000, 'Replaced by a new broadcast');
      } catch {}
      this.socket = server;
      this.header = null;
      this.latest = null;
      let queue = Promise.resolve();
      server.addEventListener('message', (event) => {
        queue = queue.then(async () => {
          if (this.socket !== server) return;
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : typeof event.data === 'string' ? null : new Uint8Array(await event.data.arrayBuffer());
          if (!bytes) return;
          if (!this.header) {
            this.header = bytes;
            return;
          }
          this.latest = bytes;
          for (const viewer of this.viewers) {
            try {
              viewer.enqueue(bytes);
            } catch {
              this.viewers.delete(viewer);
            }
          }
        });
      });
      server.addEventListener('close', () => {
        if (this.socket !== server) return;
        this.socket = null;
        for (const viewer of this.viewers) {
          try {
            viewer.close();
          } catch {}
        }
        this.viewers.clear();
        this.header = null;
        this.latest = null;
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.header) return json({ error: 'Nobody is streaming here now' }, 404);
    const viewers = this.viewers;
    const opening = [this.header, this.latest].filter(Boolean);
    let self;
    const readable = new ReadableStream({
      start(controller) {
        self = controller;
        for (const bytes of opening) controller.enqueue(bytes);
        viewers.add(controller);
      },
      cancel() {
        viewers.delete(self);
      },
    });
    return new Response(readable, { headers: { ...CORS, 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const live = /^\/live\/([\w-]{1,40})(\.gcast|\/broadcast)$/.exec(url.pathname);
    if (live) {
      if (live[2] === '/broadcast' && (!env.HUB_KEY || url.searchParams.get('key') !== env.HUB_KEY)) return json({ error: 'Wrong upload key' }, 403);
      return env.ROOM.get(env.ROOM.idFromName(live[1])).fetch(request);
    }
    try {
      const file = /^\/v\/([\w-]{11}(?:-\d{2,4})?)\.(gcast|jpg|vtt)$/.exec(url.pathname);
      if (file && (request.method === 'GET' || request.method === 'HEAD')) return serveFile(request, env, `${file[1]}.${file[2]}`);
      if (url.pathname === '/upload' && request.method === 'POST') return publish(request, env, url);
      if (url.pathname.startsWith('/admin/')) {
        if (!allowed(request, env)) return json({ error: 'Wrong upload key' }, 403);
        if (url.pathname === '/admin/videos' && request.method === 'GET') return adminList(env);
        const target = /^\/admin\/videos\/([\w-]{11})(\/delete)?$/.exec(url.pathname);
        if (target && request.method === 'POST') return target[2] ? adminDelete(env, target[1]) : adminUpdate(request, env, target[1]);
        return json({ error: 'Not found' }, 404);
      }
      if (url.pathname === '/parts/start' && request.method === 'POST') return allowed(request, env) ? json({ id: newId(), part: PART }) : json({ error: 'Wrong upload key' }, 403);
      const part = /^\/parts\/([\w-]{11})\/(\d{1,4})$/.exec(url.pathname);
      if (part && request.method === 'POST') return partUpload(request, env, part[1], Number(part[2]));
      const finish = /^\/parts\/([\w-]{11})\/finish$/.exec(url.pathname);
      if (finish && request.method === 'POST') return partFinish(request, env, finish[1], url);
      const image = /^\/poster\/([\w-]{11})$/.exec(url.pathname);
      if (image && request.method === 'POST') return poster(request, env, image[1]);
      const extra = /^\/variant\/([\w-]{11})$/.exec(url.pathname);
      if (extra && request.method === 'POST') return variant(request, env, extra[1], url);
      const captions = /^\/subtitles\/([\w-]{11})$/.exec(url.pathname);
      if (captions && request.method === 'POST') return subtitles(request, env, captions[1]);
      if (url.pathname === '/') return json({ hub: env.REPO, files: '/v/<id>.gcast', upload: 'POST /upload?title=&license=&listed=1 with x-hub-key' });
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },
};
