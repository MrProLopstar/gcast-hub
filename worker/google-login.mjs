// Connects the hub worker to Google Drive.
//   node google-login.mjs <client_secret_….json>
// Opens Google sign-in, creates the "gcast-hub videos" folder, and stores the keys as worker secrets with
// wrangler. A copy for local scripts (migrate-to-drive.mjs) goes to .google.json, which git ignores.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const file = process.argv[2];
if (!file) {
  console.log('Usage: node google-login.mjs <client_secret_….json from Google Cloud Console>');
  process.exit(1);
}
const { installed } = JSON.parse(readFileSync(file, 'utf8'));
const { client_id: clientId, client_secret: clientSecret } = installed;
// drive.file: the worker sees only files it made itself, nothing else on the Drive
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const code = await new Promise((resolve, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const found = url.searchParams.get('code');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(found ? '<h2>Готово, вернитесь в терминал.</h2>' : `<h2>Не получилось: ${url.searchParams.get('error') ?? 'нет кода'}</h2>`);
    server.close();
    if (found) resolve(found);
    else reject(new Error(url.searchParams.get('error') ?? 'no code'));
  });
  server.listen(0, '127.0.0.1', () => {
    const redirect = `http://localhost:${server.address().port}`;
    process.env.REDIRECT = redirect;
    const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' })}`;
    console.log('Открываю вход в Google. Если браузер не открылся, откройте ссылку сами:\n' + auth);
    spawn(process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', auth.replace(/&/g, '^&')] : [auth], { stdio: 'ignore', detached: true }).on('error', () => undefined);
  });
});

const tokens = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: process.env.REDIRECT, grant_type: 'authorization_code' }),
}).then((response) => response.json());
if (!tokens.refresh_token) throw new Error(`Google did not give a refresh token: ${JSON.stringify(tokens)}`);

const folder = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
  method: 'POST',
  headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'gcast-hub videos', mimeType: 'application/vnd.google-apps.folder' }),
}).then((response) => response.json());
if (!folder.id) throw new Error(`Cannot create the folder: ${JSON.stringify(folder)}`);
console.log('Папка «gcast-hub videos» создана на Диске.');

const secrets = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: tokens.refresh_token, DRIVE_FOLDER: folder.id };
writeFileSync(new URL('./.google.json', import.meta.url), JSON.stringify(secrets, null, 2));
for (const [name, value] of Object.entries(secrets)) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'], shell: true, cwd: new URL('.', import.meta.url) });
  if (result.status !== 0) throw new Error(`wrangler secret put ${name} failed`);
}
console.log('Готово: воркер подключён к Google Диску. Теперь: npx wrangler deploy');
