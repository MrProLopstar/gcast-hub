// Moves the hub off GitHub: copies every file from the "videos" release to the Google Drive folder (videos
// uploaded in parts become one file again) and loads the open list into the worker.
//   GLYPHCAST_HUB_KEY=<key> node migrate-to-drive.mjs
// Needs .google.json from google-login.mjs and the new worker deployed. Files already on the Drive are skipped,
// so the script can be run again after a failure. Afterwards delete the "videos" release on GitHub by hand.
import { readFileSync } from 'node:fs';

const REPO = 'MrProLopstar/gcast-hub';
const WORKER = 'https://gcast-hub.aniclap.workers.dev';
const google = JSON.parse(readFileSync(new URL('./.google.json', import.meta.url), 'utf8'));
const key = process.env.GLYPHCAST_HUB_KEY;
if (!key) throw new Error('Set GLYPHCAST_HUB_KEY first');

let token = '';
const refresh = async () => {
  const answer = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: google.GOOGLE_CLIENT_ID, client_secret: google.GOOGLE_CLIENT_SECRET, refresh_token: google.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  }).then((response) => response.json());
  token = answer.access_token;
};
await refresh();
setInterval(refresh, 45 * 60 * 1000).unref();

const onDrive = async (name) => {
  const q = `name = '${name}' and '${google.DRIVE_FOLDER}' in parents and trashed = false`;
  const found = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)' })}`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  return (found.files ?? []).length > 0;
};

const release = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/videos`).then((response) => response.json());
const assets = release.assets ?? [];
const download = (name) => `https://github.com/${REPO}/releases/download/videos/${encodeURIComponent(name)}`;

// one Drive file per name; parts of a big video are listed in <id>.parts
const files = new Map();
for (const asset of assets) {
  if (/\.gcast\.\d+$/.test(asset.name)) continue;
  if (asset.name.endsWith('.parts')) {
    const { sizes } = await fetch(download(asset.name)).then((response) => response.json());
    const id = asset.name.slice(0, -6);
    files.set(`${id}.gcast`, { size: sizes.reduce((sum, size) => sum + size, 0), sources: sizes.map((_, index) => download(`${id}.gcast.${index}`)) });
  } else files.set(asset.name, { size: asset.size, sources: [download(asset.name)] });
}

const CHUNK = 32 * 262144;
for (const [name, { size, sources }] of files) {
  if (await onDrive(name)) {
    console.log(`${name}: already on the Drive`);
    continue;
  }
  const type = name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.vtt') ? 'text/vtt' : 'application/octet-stream';
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8', 'x-upload-content-type': type, 'x-upload-content-length': String(size) },
    body: JSON.stringify({ name, parents: [google.DRIVE_FOLDER] }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error(`${name}: Drive did not start the upload: ${await start.text()}`);
  let sent = 0;
  let pending = new Uint8Array(0);
  const flush = async (final) => {
    while (pending.length >= CHUNK || (final && pending.length > 0)) {
      const piece = pending.length >= CHUNK ? pending.subarray(0, CHUNK) : pending;
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetch(session, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-range': `bytes ${sent}-${sent + piece.length - 1}/${size}` }, body: piece });
        if (response.status === 308 || response.ok) break;
        if (attempt >= 5) throw new Error(`${name}: Drive refused bytes from ${sent}: ${response.status} ${await response.text()}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
      sent += piece.length;
      pending = pending.subarray(piece.length);
      process.stdout.write(`\r${name}: ${Math.round((sent / size) * 100)}%   `);
    }
  };
  for (const source of sources) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${name}: GitHub answered ${response.status}`);
    for await (const bytes of response.body) {
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending);
      joined.set(bytes, pending.length);
      pending = joined;
      await flush(false);
    }
  }
  await flush(true);
  console.log(`\r${name}: moved, ${(size / 1048576).toFixed(1)} MB`);
}

const catalog = await fetch(`https://raw.githubusercontent.com/${REPO}/main/videos.json`).then((response) => response.json());
const done = await fetch(`${WORKER}/admin/import`, { method: 'POST', headers: { 'x-hub-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ catalog }) }).then((response) => response.json());
console.log(`Open list moved to the worker: ${JSON.stringify(done)}`);
console.log('All files are on the Drive. Check the hub, then delete the "videos" release on GitHub.');
