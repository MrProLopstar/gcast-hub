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
  if (listed) await catalog(env, (videos) => {
    const taken = new Set(videos.map((video) => video.slug));
    if (taken.has(entry.slug)) entry.slug = `${entry.slug}-${id.slice(0, 4)}`;
    return [entry, ...videos];
  });
  return json(entry, 201);
};

const poster = async (request, env, id) => {
  if (!env.HUB_KEY || request.headers.get('x-hub-key') !== env.HUB_KEY) return json({ error: 'Wrong upload key' }, 403);
  await upload(env, `${id}.jpg`, request.body, 'image/jpeg', Number(request.headers.get('content-length') ?? 0));
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, poster: true } : video)));
  return json({ ok: true });
};

const subtitles = async (request, env, id) => {
  if (!env.HUB_KEY || request.headers.get('x-hub-key') !== env.HUB_KEY) return json({ error: 'Wrong upload key' }, 403);
  await upload(env, `${id}.vtt`, request.body, 'text/vtt; charset=utf-8', Number(request.headers.get('content-length') ?? 0));
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, subtitles: true } : video)));
  return json({ ok: true });
};

const TYPES = { jpg: 'image/jpeg', vtt: 'text/vtt; charset=utf-8', gcast: 'application/octet-stream' };

const serveFile = async (request, env, name) => {
  const headers = new Headers({ 'user-agent': 'gcast-hub' });
  const range = request.headers.get('range');
  if (range) headers.set('range', range);
  const upstream = await fetch(`https://github.com/${env.REPO}/releases/download/${TAG}/${encodeURIComponent(name)}`, { headers, redirect: 'follow', cf: { cacheEverything: true, cacheTtl: 86400 } });
  const out = new Headers(CORS);
  for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  out.set('content-type', TYPES[name.split('.').pop()] ?? 'application/octet-stream');
  out.set('cache-control', 'public, max-age=86400');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      const file = /^\/v\/([\w-]{11})\.(gcast|jpg|vtt)$/.exec(url.pathname);
      if (file && (request.method === 'GET' || request.method === 'HEAD')) return serveFile(request, env, `${file[1]}.${file[2]}`);
      if (url.pathname === '/upload' && request.method === 'POST') return publish(request, env, url);
      const image = /^\/poster\/([\w-]{11})$/.exec(url.pathname);
      if (image && request.method === 'POST') return poster(request, env, image[1]);
      const captions = /^\/subtitles\/([\w-]{11})$/.exec(url.pathname);
      if (captions && request.method === 'POST') return subtitles(request, env, captions[1]);
      if (url.pathname === '/') return json({ hub: env.REPO, files: '/v/<id>.gcast', upload: 'POST /upload?title=&license=&listed=1 with x-hub-key' });
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },
};
