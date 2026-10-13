const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, content-type, x-hub-key, x-edit-token',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges',
};
const LICENSES = ['CC0', 'CC-BY', 'CC-BY-SA', 'CC-BY-NC', 'public-domain', 'own'];
const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ_-';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });

let access = { token: '', until: 0 };

/** An access token for Drive from the refresh token in the worker secrets, reused until it expires. */
const driveToken = async (env) => {
  if (access.until > Date.now() + 60000) return access.token;
  const answer = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  }).then((response) => response.json());
  if (!answer.access_token) throw new Error(`Google Drive refused the worker: ${answer.error ?? 'no token'}`);
  access = { token: answer.access_token, until: Date.now() + (answer.expires_in ?? 3600) * 1000 };
  return access.token;
};

const drive = async (env, path, init = {}) =>
  fetch(path.startsWith('https://') ? path : `https://www.googleapis.com${path}`, { ...init, headers: { authorization: `Bearer ${await driveToken(env)}`, ...init.headers } });

/** Drive file id for a name in the hub folder, remembered in the index. */
const fileId = async (env, name) => {
  const known = await hidden(env).fetch(`https://index/file?name=${encodeURIComponent(name)}`).then((response) => response.json());
  if (known?.id) return known.id;
  const query = `name = '${name.replace(/'/g, "\\'")}' and '${env.DRIVE_FOLDER}' in parents and trashed = false`;
  const found = await drive(env, `/drive/v3/files?${new URLSearchParams({ q: query, fields: 'files(id,size)' })}`).then((response) => response.json());
  const file = found.files?.[0];
  if (file) await hidden(env).fetch(`https://index/file?name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ id: file.id, size: Number(file.size ?? 0) }) });
  return file?.id ?? null;
};

/** Starts a resumable Drive upload and returns its session URL. */
const session = async (env, name, type, size) => {
  const response = await drive(env, '/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-upload-content-type': type, ...(size ? { 'x-upload-content-length': String(size) } : {}) },
    body: JSON.stringify({ name, parents: [env.DRIVE_FOLDER] }),
  });
  const url = response.headers.get('location');
  if (!url) throw new Error(`Google Drive did not start the upload: ${response.status} ${await response.text()}`);
  return url;
};

/** Sends bytes `from`..`from + size - 1` of a `total`-byte file to a session; returns the file once the last byte is in. */
const sendRange = async (env, url, body, from, size, total) => {
  const sized = new FixedLengthStream(size);
  body.pipeTo(sized.writable).catch(() => undefined);
  const response = await drive(env, url, { method: 'PUT', body: sized.readable, headers: { 'content-length': String(size), 'content-range': `bytes ${from}-${from + size - 1}/${total}` } });
  if (response.status === 308) return null;
  if (!response.ok) throw new Error(`Google Drive refused the upload: ${response.status} ${await response.text()}`);
  return response.json();
};

const rememberFile = async (env, name, file) => {
  await hidden(env).fetch(`https://index/file?name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ id: file.id, size: Number(file.size ?? 0) }) });
};

const upload = async (env, name, body, type, size) => {
  const old = await fileId(env, name);
  const file = await sendRange(env, await session(env, name, type, size), body, 0, size, size);
  await rememberFile(env, name, file);
  // a new poster or subtitles replace the old file
  if (old && old !== file.id) await drive(env, `/drive/v3/files/${old}`, { method: 'DELETE' });
};

const asset = async (env, name, range) => {
  const id = await fileId(env, name);
  if (!id) return new Response(null, { status: 404 });
  return drive(env, `/drive/v3/files/${id}?alt=media`, { headers: range ? { range } : {} });
};

const removeFiles = async (env, id) => {
  const listed = await hidden(env).fetch(`https://index/files?prefix=${id}`).then((response) => response.json());
  for (const [name, file] of Object.entries(listed)) {
    await drive(env, `/drive/v3/files/${file.id}`, { method: 'DELETE' });
    await hidden(env).fetch(`https://index/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
};

/** The open list, kept in the index object; `change` maps the old list to the new one. */
const catalog = async (env, change) => {
  const videos = await readCatalog(env);
  const next = change(videos);
  await hidden(env).fetch('https://index/catalog', { method: 'POST', body: JSON.stringify(next) });
  return next;
};

const readCatalog = (env) => hidden(env).fetch('https://index/catalog').then((response) => response.json());

const describe = (head) => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 20 || view.getUint32(0, true) !== 0x54534347) throw new Error('This is not a .gcast file');
  const fps = view.getFloat32(10, true);
  return { cols: view.getUint16(6, true), rows: view.getUint16(8, true), fps, duration: Math.round((view.getUint32(16, true) / fps) * 10) / 10 };
};

/**
 * Checks a .gcast stream while it passes through: the header must be a sane v3 header and every chunk must be
 * framed as <u32 size><u16 frames><data>, up to the optional 8-byte index trailer. Anything else (an executable,
 * an archive, a renamed video) breaks the stream and the upload fails. `state` carries the position across parts.
 */
const checker = (state) => {
  const pending = [];
  let held = 0;
  const take = (count) => {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const first = pending[0];
      const used = Math.min(first.length, count - filled);
      out.set(first.subarray(0, used), filled);
      filled += used;
      if (used === first.length) pending.shift();
      else pending[0] = first.subarray(used);
    }
    held -= count;
    return out;
  };
  const skip = (count) => {
    while (count > 0 && pending.length) {
      const first = pending[0];
      const used = Math.min(first.length, count);
      if (used === first.length) pending.shift();
      else pending[0] = first.subarray(used);
      held -= used;
      count -= used;
    }
    return count;
  };
  const step = () => {
    for (;;) {
      if (state.skip > 0) {
        state.skip = skip(state.skip);
        if (state.skip > 0) return;
      }
      if (!state.header) {
        if (held < 20) return;
        const head = take(20);
        const view = new DataView(head.buffer);
        const cols = view.getUint16(6, true);
        const rows = view.getUint16(8, true);
        const fps = view.getFloat32(10, true);
        if (view.getUint32(0, true) !== 0x54534347 || head[4] !== 3 || cols < 8 || cols > 1000 || rows < 2 || rows > 600 || !(fps > 0 && fps <= 120)) throw new Error('This is not a .gcast v3 file');
        state.header = true;
        continue;
      }
      if (held < 6) return;
      const frame = take(6);
      const view = new DataView(frame.buffer);
      const size = view.getUint32(0, true);
      const frames = view.getUint16(4, true);
      // the index trailer: <u32 length><"GIDX">, only as the very last 8 bytes
      if (frames === 0x4947 && frame[4] === 0x47 && frame[5] === 0x49) {
        state.trailer = true;
        state.skip = 2;
        continue;
      }
      if (state.trailer) throw new Error('Data after the end of the .gcast file');
      if (size > 64 * 1048576) throw new Error('A chunk of this file is too large for a .gcast');
      state.skip = size;
    }
  };
  return new TransformStream({
    transform(bytes, controller) {
      pending.push(bytes);
      held += bytes.length;
      step();
      controller.enqueue(bytes);
    },
    flush() {
      if (state.last && (state.skip > 0 || held > 0 || !state.header)) throw new Error('The .gcast file ends in the middle of a chunk');
    },
  });
};

const DAY_LIMIT = { uploads: 6, bytes: 2 * 1024 * 1048576 };

const visitor = async (request) => {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gcast-hub:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Counts an upload of `bytes` for this visitor today; false when the daily limit is used up. */
const spend = async (env, who, bytes, uploads) => {
  const answer = await hidden(env).fetch(`https://index/spend?who=${who}&bytes=${bytes}&uploads=${uploads}`, { method: 'POST' });
  return answer.ok;
};

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

/** The hub key, or the edit token the uploader got for this video. */
const mayEdit = async (request, env, id) => {
  if (allowed(request, env)) return true;
  const given = request.headers.get('x-edit-token');
  if (!given) return false;
  const entry = await hidden(env).fetch(`https://index/get?id=${id}`).then((response) => (response.ok ? response.json() : null));
  return Boolean(entry?.token && entry.token === given);
};

const PRIVATE = ['token', 'who'];
const visible = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !PRIVATE.includes(key)));

const cleanSource = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) ? url.href.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
};

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);

const PART = 90 * 1048576;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(11)), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
const allowed = (request, env) => Boolean(env.HUB_KEY) && request.headers.get('x-hub-key') === env.HUB_KEY;
const PART_LIMIT = 30;

const fields = (url, admin) => {
  const title = (url.searchParams.get('title') ?? '').trim().slice(0, 120);
  const license = url.searchParams.get('license') ?? 'own';
  const wanted = url.searchParams.get('listed') === '1';
  const source = cleanSource(url.searchParams.get('source'));
  if (!title) return { error: 'A title is needed' };
  if (!LICENSES.includes(license)) return { error: `License must be one of ${LICENSES.join(', ')}` };
  if (wanted && license === 'own') return { error: 'Only openly licensed videos can be listed; choose a license or keep it unlisted' };
  // without the hub key a video waits for review before it reaches the open list
  return { title, license, listed: wanted && admin, ...(wanted && !admin ? { review: true } : {}), ...(source ? { source } : {}) };
};

const hidden = (env) => env.INDEX.get(env.INDEX.idFromName('unlisted'));

const keepHidden = (env, entry) => hidden(env).fetch('https://index/put', { method: 'POST', body: JSON.stringify(entry) });

const remember = async (env, entry) => {
  if (entry.listed) await catalog(env, (videos) => {
    entry = visible(entry);
    const taken = new Set(videos.map((video) => video.slug));
    if (taken.has(entry.slug)) entry.slug = `${entry.slug}-${entry.id.slice(0, 4)}`;
    return [entry, ...videos];
  });
  else await keepHidden(env, entry);
  return json(visible(entry), 201);
};

const adminList = async (env) => {
  const [listed, unlisted, stored] = await Promise.all([
    readCatalog(env),
    hidden(env).fetch('https://index/list').then((response) => response.json()),
    hidden(env).fetch('https://index/files?prefix=').then((response) => response.json()),
  ]);
  const assets = Object.entries(stored).map(([name, file]) => ({ name, size: file.size }));
  const known = new Set([...listed, ...unlisted].map((video) => video.id));
  const files = new Map();
  for (const item of assets) {
    const id = item.name.slice(0, 11);
    files.set(id, (files.get(id) ?? 0) + (/^[\w-]{11}\.gcast$/.test(item.name) ? item.size : 0));
  }
  const orphans = [...files].filter(([id, size]) => !known.has(id) && size > 0).map(([id, size]) => ({ id, slug: id, title: '', license: 'own', listed: false, size, orphan: true }));
  const stats = await hidden(env).fetch(`https://index/stats?ids=${[...listed, ...unlisted].map((video) => video.id).slice(0, 100).join(',')}`).then((response) => response.json());
  return json({ videos: [...listed, ...unlisted, ...orphans].map((video) => ({ ...visible(video), files: files.get(video.id) ?? 0, stats: stats[video.id] })) });
};

const adminUpdate = async (request, env, id) => {
  const change = await request.json();
  const listed = await readCatalog(env);
  const unlisted = await hidden(env).fetch('https://index/list').then((response) => response.json());
  let entry = listed.find((video) => video.id === id) ?? unlisted.find((video) => video.id === id);
  if (!entry) {
    const first = await asset(env, `${id}.gcast`, 'bytes=0-19');
    if (!first.ok) return json({ error: 'No such video' }, 404);
    entry = { id, slug: id, title: id, license: 'own', listed: false, size: 0, ...describe(new Uint8Array(await first.arrayBuffer())), poster: false, added: new Date().toISOString().slice(0, 10) };
  }
  const title = typeof change.title === 'string' && change.title.trim() ? change.title.trim().slice(0, 120) : entry.title;
  const license = typeof change.license === 'string' && LICENSES.includes(change.license) ? change.license : entry.license;
  const wantsListed = typeof change.listed === 'boolean' ? change.listed : entry.listed;
  if (wantsListed && license === 'own') return json({ error: 'Only openly licensed videos can be listed' }, 400);
  const source = 'source' in change ? cleanSource(change.source) : entry.source;
  const next = { ...entry, title, license, listed: wantsListed, slug: entry.listed === wantsListed && entry.title === title ? entry.slug : slugify(title) || id };
  if (source) next.source = source;
  else delete next.source;
  if (wantsListed) delete next.review;
  await catalog(env, (videos) => {
    const others = videos.filter((video) => video.id !== id);
    if (!wantsListed) return others;
    const taken = new Set(others.map((video) => video.slug));
    if (taken.has(next.slug)) next.slug = `${next.slug}-${id.slice(0, 4)}`;
    const at = videos.findIndex((video) => video.id === id);
    if (at < 0) return [visible(next), ...others];
    return videos.map((video) => (video.id === id ? visible(next) : video));
  });
  if (wantsListed) await hidden(env).fetch(`https://index/delete?id=${id}`, { method: 'POST' });
  else await keepHidden(env, next);
  return json(visible(next));
};

const adminDelete = async (env, id) => {
  await removeFiles(env, id);
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
    if (url.pathname === '/catalog') {
      if (request.method === 'POST') await this.storage.put('catalog', await request.json());
      return Response.json((await this.storage.get('catalog')) ?? []);
    }
    if (url.pathname === '/file') {
      const key = `file:${url.searchParams.get('name')}`;
      if (request.method === 'POST') await this.storage.put(key, await request.json());
      if (request.method === 'DELETE') await this.storage.delete(key);
      return Response.json((await this.storage.get(key)) ?? null);
    }
    if (url.pathname === '/files') {
      const found = await this.storage.list({ prefix: `file:${url.searchParams.get('prefix') ?? ''}` });
      return Response.json(Object.fromEntries([...found].map(([key, value]) => [key.slice(5), value])));
    }
    if (url.pathname === '/get') {
      const entry = await this.storage.get(`video:${url.searchParams.get('id')}`);
      return entry ? Response.json(entry) : Response.json({ error: 'No such video' }, { status: 404 });
    }
    if (url.pathname === '/spend') {
      const key = `quota:${url.searchParams.get('who')}:${new Date().toISOString().slice(0, 10)}`;
      const used = (await this.storage.get(key)) ?? { uploads: 0, bytes: 0 };
      const next = { uploads: used.uploads + Number(url.searchParams.get('uploads') ?? 0), bytes: used.bytes + Number(url.searchParams.get('bytes') ?? 0) };
      if (next.uploads > DAY_LIMIT.uploads || next.bytes > DAY_LIMIT.bytes) return Response.json({ error: 'limit' }, { status: 429 });
      await this.storage.put(key, next);
      return Response.json(next);
    }
    if (url.pathname === '/upload-state') {
      const key = `upload:${url.searchParams.get('id')}`;
      if (request.method === 'POST') await this.storage.put(key, await request.json());
      return Response.json((await this.storage.get(key)) ?? null);
    }
    if (url.pathname === '/stats') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => /^[\w-]{11}$/.test(id)).slice(0, 100);
      const found = await this.storage.get(ids.map((id) => `stats:${id}`));
      return Response.json(Object.fromEntries(ids.map((id) => [id, found.get(`stats:${id}`) ?? { views: 0, up: 0, down: 0 }])));
    }
    if (url.pathname === '/view' || url.pathname === '/vote') {
      const id = url.searchParams.get('id');
      const who = url.searchParams.get('who');
      const key = `stats:${id}`;
      const stats = (await this.storage.get(key)) ?? { views: 0, up: 0, down: 0 };
      if (url.pathname === '/view') {
        // ponytail: one view per visitor per day, the seen keys pile up; clean them with an alarm when it matters
        const seen = `seen:${id}:${who}:${new Date().toISOString().slice(0, 10)}`;
        if (!(await this.storage.get(seen))) {
          await this.storage.put(seen, 1);
          stats.views += 1;
        }
      } else {
        const ballot = `vote:${id}:${who}`;
        const before = (await this.storage.get(ballot)) ?? 0;
        const vote = Math.max(-1, Math.min(1, Math.round(Number(url.searchParams.get('value') ?? 0)))) || 0;
        if (before === 1) stats.up -= 1;
        if (before === -1) stats.down -= 1;
        if (vote === 1) stats.up += 1;
        if (vote === -1) stats.down += 1;
        await this.storage.put(ballot, vote);
        stats.mine = vote;
      }
      const { mine, ...kept } = stats;
      await this.storage.put(key, kept);
      return Response.json(stats);
    }
    if (url.pathname === '/mine') {
      return Response.json({ vote: (await this.storage.get(`vote:${url.searchParams.get('id')}:${url.searchParams.get('who')}`)) ?? 0 });
    }
    return new Response('Not found', { status: 404 });
  }
}

const partsStart = async (request, env, url) => {
  const total = Number(url.searchParams.get('size') ?? 0);
  if (!total || total > PART * PART_LIMIT) return json({ error: `Say the file size: /parts/start?size=<bytes>, up to ${PART * PART_LIMIT} bytes` }, 400);
  const id = newId();
  const edit = token();
  const upload = await session(env, `${id}.gcast`, 'application/octet-stream', total);
  await hidden(env).fetch(`https://index/upload-state?id=${id}`, { method: 'POST', body: JSON.stringify({ token: edit, next: 0, offset: 0, total, upload, check: { header: false, skip: 0, trailer: false }, who: await visitor(request) }) });
  return json({ id, part: PART, token: edit });
};

const partUpload = async (request, env, id, index) => {
  const state = await hidden(env).fetch(`https://index/upload-state?id=${id}`).then((response) => response.json());
  const admin = allowed(request, env);
  if (!state || (!admin && request.headers.get('x-edit-token') !== state.token)) return json({ error: 'Unknown upload or wrong token' }, 403);
  if (index >= PART_LIMIT) return json({ error: `At most ${PART_LIMIT} parts` }, 400);
  if (index < state.next) return json({ ok: true, already: true });
  if (index !== state.next) return json({ error: `Send part ${state.next} first` }, 409);
  const size = Number(request.headers.get('content-length') ?? 0);
  const last = state.offset + size === state.total;
  // Drive takes resumable pieces in multiples of 256 KiB, except the last one
  if (!size || size > PART || state.offset + size > state.total || (!last && size % 262144 !== 0)) return json({ error: `A part must be ${PART} bytes (the last one: the rest of the file)` }, 400);
  if (!admin && !(await spend(env, state.who, size, index === 0 ? 1 : 0))) return json({ error: 'The daily upload limit for your address is used up, try tomorrow' }, 429);
  const check = { ...state.check, last };
  const file = await sendRange(env, state.upload, request.body.pipeThrough(checker(check)), state.offset, size, state.total);
  delete check.last;
  if (file) await rememberFile(env, `${id}.gcast`, file);
  await hidden(env).fetch(`https://index/upload-state?id=${id}`, { method: 'POST', body: JSON.stringify({ ...state, next: index + 1, offset: state.offset + size, check, done: Boolean(file) }) });
  return json({ ok: true });
};

const partFinish = async (request, env, id, url) => {
  const state = await hidden(env).fetch(`https://index/upload-state?id=${id}`).then((response) => response.json());
  const admin = allowed(request, env);
  if (!state || (!admin && request.headers.get('x-edit-token') !== state.token)) return json({ error: 'Unknown upload or wrong token' }, 403);
  if (state.check.skip > 0 || !state.check.header) return json({ error: 'The .gcast file ends in the middle of a chunk' }, 400);
  const given = fields(url, admin);
  if (given.error) return json(given, 400);
  if (!state.done) return json({ error: `Only ${state.offset} of ${state.total} bytes arrived` }, 400);
  const head = await asset(env, `${id}.gcast`, 'bytes=0-19');
  if (!head.ok) return json({ error: 'The file is missing on the Drive' }, 500);
  const info = describe(new Uint8Array(await head.arrayBuffer()));
  const size = state.total;
  const entry = { id, slug: slugify(given.title) || id, ...given, size, ...info, poster: false, added: new Date().toISOString().slice(0, 10), ...(admin ? {} : { token: state.token, who: state.who }) };
  const answer = await remember(env, entry);
  return admin ? answer : json({ ...visible(entry), token: state.token }, 201);
};

const publish = async (request, env, url) => {
  const admin = allowed(request, env);
  const given = fields(url, admin);
  if (given.error) return json(given, 400);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size) return json({ error: 'Send the file with a content-length' }, 411);
  if (size > PART) return json({ error: `Files over ${PART} bytes go in parts: POST /parts/start` }, 413);
  const who = await visitor(request);
  if (!admin && !(await spend(env, who, size, 1))) return json({ error: 'The daily upload limit for your address is used up, try tomorrow' }, 429);
  const [peek, body] = request.body.tee();
  const reader = peek.getReader();
  const first = await reader.read();
  reader.cancel();
  const info = describe(first.value ?? new Uint8Array());
  const id = newId();
  await upload(env, `${id}.gcast`, body.pipeThrough(checker({ last: true })), 'application/octet-stream', size);
  const edit = token();
  const entry = { id, slug: slugify(given.title) || id, ...given, size, ...info, poster: false, added: new Date().toISOString().slice(0, 10), ...(admin ? {} : { token: edit, who }) };
  const answer = await remember(env, entry);
  return admin ? answer : json({ ...visible(entry), token: edit }, 201);
};

const poster = async (request, env, id) => {
  if (!(await mayEdit(request, env, id))) return json({ error: 'Wrong upload key or edit token' }, 403);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size || size > 2 * 1048576) return json({ error: 'A poster must be a JPEG up to 2 MB' }, 400);
  const [peek, body] = request.body.tee();
  const reader = peek.getReader();
  const first = await reader.read();
  reader.cancel();
  if (first.value?.[0] !== 0xff || first.value?.[1] !== 0xd8) return json({ error: 'A poster must be a JPEG' }, 400);
  await upload(env, `${id}.jpg`, body, 'image/jpeg', size);
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, poster: true } : video)));
  await hidden(env).fetch(`https://index/patch?id=${id}`, { method: 'POST', body: JSON.stringify({ poster: true }) });
  return json({ ok: true });
};

const variant = async (request, env, id, url) => {
  if (!(await mayEdit(request, env, id))) return json({ error: 'Wrong upload key or edit token' }, 403);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size || size > PART) return json({ error: `A variant must be from 1 byte to ${PART} bytes` }, 400);
  const [peek, body] = request.body.tee();
  const reader = peek.getReader();
  const first = await reader.read();
  reader.cancel();
  const { cols } = describe(first.value ?? new Uint8Array());
  await upload(env, `${id}-${cols}.gcast`, body.pipeThrough(checker({ last: true })), 'application/octet-stream', size);
  const add = (video) => (video.id === id ? { ...video, variants: [...new Set([...(video.variants ?? []), cols])].sort((a, b) => a - b) } : video);
  await catalog(env, (videos) => videos.map(add));
  const unlisted = await hidden(env).fetch('https://index/list').then((response) => response.json());
  const entry = unlisted.find((video) => video.id === id);
  if (entry) await keepHidden(env, add(entry));
  return json({ ok: true, cols });
};

const subtitles = async (request, env, id) => {
  if (!(await mayEdit(request, env, id))) return json({ error: 'Wrong upload key or edit token' }, 403);
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!size || size > 2 * 1048576) return json({ error: 'Subtitles must be WebVTT up to 2 MB' }, 400);
  const text = await request.text();
  if (!text.trimStart().startsWith('WEBVTT')) return json({ error: 'Subtitles must be WebVTT (the file starts with WEBVTT)' }, 400);
  const bytes = new TextEncoder().encode(text);
  await upload(env, `${id}.vtt`, new Blob([bytes]).stream(), 'text/vtt; charset=utf-8', bytes.length);
  await catalog(env, (videos) => videos.map((video) => (video.id === id ? { ...video, subtitles: true } : video)));
  await hidden(env).fetch(`https://index/patch?id=${id}`, { method: 'POST', body: JSON.stringify({ subtitles: true }) });
  return json({ ok: true });
};

const meta = async (env, id) => {
  const unlisted = await hidden(env).fetch(`https://index/get?id=${id}`);
  if (unlisted.ok) return json(visible(await unlisted.json()));
  const listed = (await readCatalog(env)).find((video) => video.id === id);
  return listed ? json(listed) : json({ error: 'No such video' }, 404);
};

const TYPES = { jpg: 'image/jpeg', vtt: 'text/vtt; charset=utf-8', gcast: 'application/octet-stream' };

const serveFile = async (request, env, name) => {
  const range = request.headers.get('range');
  const cache = caches.default;
  // Drive answers need the token, so Cloudflare does not cache them by itself: keep each answer under the public URL and range
  const key = new Request(`${new URL(request.url).origin}/v/${name}?range=${encodeURIComponent(range ?? '')}`);
  if (request.method === 'GET') {
    const cached = await cache.match(key);
    if (cached) return cached;
  }
  const upstream = await asset(env, name, range);
  const out = new Headers(CORS);
  for (const header of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header);
    if (value) out.set(header, value);
  }
  out.set('accept-ranges', 'bytes');
  out.set('content-type', TYPES[name.split('.').pop()] ?? 'application/octet-stream');
  out.set('cache-control', 'public, max-age=86400');
  if (request.method === 'HEAD' || !upstream.ok) return new Response(null, { status: upstream.ok ? upstream.status : 404, headers: out });
  const [give, keep] = upstream.body.tee();
  // ponytail: the cache keeps answers up to 50 MB; whole-file downloads of big videos always go to Drive
  if (Number(out.get('content-length') ?? 0) < 50 * 1048576) await cache.put(key, new Response(keep, { status: upstream.status, headers: out })).catch(() => undefined);
  else keep.cancel();
  return new Response(give, { status: upstream.status, headers: out });
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
      if (url.pathname === '/parts/start' && request.method === 'POST') return partsStart(request, env, url);
      if (url.pathname === '/videos' && request.method === 'GET') return new Response(JSON.stringify(await readCatalog(env)), { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' } });
      if (url.pathname === '/admin/import' && request.method === 'POST') {
        if (!allowed(request, env)) return json({ error: 'Wrong upload key' }, 403);
        const { catalog: list = [], unlisted = [] } = await request.json();
        await catalog(env, () => list);
        for (const entry of unlisted) await keepHidden(env, entry);
        return json({ ok: true, listed: list.length, unlisted: unlisted.length });
      }
      const about = /^\/meta\/([\w-]{11})$/.exec(url.pathname);
      if (about && request.method === 'GET') return meta(env, about[1]);
      if (url.pathname === '/stats' && request.method === 'GET') return json(await hidden(env).fetch(`https://index/stats?ids=${encodeURIComponent(url.searchParams.get('ids') ?? '')}`).then((response) => response.json()));
      const counted = /^\/(view|vote|mine)\/([\w-]{11})$/.exec(url.pathname);
      if (counted && (request.method === 'POST' || counted[1] === 'mine')) {
        const who = await visitor(request);
        return json(await hidden(env).fetch(`https://index/${counted[1]}?id=${counted[2]}&who=${who}&value=${encodeURIComponent(url.searchParams.get('value') ?? '0')}`, { method: 'POST' }).then((response) => response.json()));
      }
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
      if (url.pathname === '/') return json({ hub: 'gcast hub', storage: 'Google Drive', files: '/v/<id>.gcast', upload: 'POST /upload?title=&license=&listed=1&source= with a .gcast body; anonymous uploads wait for review' });
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },
};
