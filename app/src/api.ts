/** Talking to the hub worker: catalog, files, stats, uploads and admin calls. */

export interface Video {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly license: string;
  readonly listed: boolean;
  readonly review?: boolean;
  readonly duration: number;
  readonly cols: number;
  readonly rows: number;
  readonly size: number;
  readonly added: string;
  readonly poster?: boolean;
  readonly subtitles?: boolean;
  readonly variants?: readonly number[];
  readonly source?: string;
  readonly description?: string;
  readonly orphan?: boolean;
  readonly files?: number;
  readonly stats?: Stats;
}

export interface Stats {
  readonly views: number;
  readonly up: number;
  readonly down: number;
  readonly mine?: number;
}

export const LICENSES: readonly (readonly [string, string])[] = [
  ['own', 'Все права у автора'],
  ['CC0', 'CC0'],
  ['CC-BY', 'CC BY'],
  ['CC-BY-SA', 'CC BY-SA'],
  ['CC-BY-NC', 'CC BY-NC'],
  ['public-domain', 'Общественное достояние'],
];
export const licenseName = (license: string): string => LICENSES.find(([value]) => value === license)?.[1] ?? license;

let base: Promise<string> | null = null;
/** The worker address from hub.json, so the site can move to another worker without a rebuild. */
export const worker = (): Promise<string> =>
  (base ??= fetch('/hub.json', { cache: 'no-cache' })
    .then((response) => response.json() as Promise<{ files: string }>)
    .then((config) => config.files.replace(/\/$/, '')));

export const fileUrl = (files: string, video: Pick<Video, 'id'>, kind: 'gcast' | 'jpg' | 'vtt', cols?: number): string =>
  `${files}/v/${video.id}${cols ? `-${cols}` : ''}.${kind}`;

/** Quality choices for the player, or undefined when there is only one grid. */
export const sources = (files: string, video: Video): string | undefined =>
  video.variants?.length
    ? JSON.stringify([{ cols: video.cols, src: fileUrl(files, video, 'gcast') }, ...video.variants.map((cols) => ({ cols, src: fileUrl(files, video, 'gcast', cols) }))])
    : undefined;

const read = async <T,>(response: Response): Promise<T> => {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
};

export const catalog = async (): Promise<Video[]> => read<Video[]>(await fetch(`${await worker()}/videos`, { cache: 'no-cache' }));

export const meta = async (id: string): Promise<Video | null> => {
  const response = await fetch(`${await worker()}/meta/${id}`);
  return response.ok ? ((await response.json()) as Video) : null;
};

export const stats = async (ids: readonly string[]): Promise<Record<string, Stats>> =>
  ids.length ? read<Record<string, Stats>>(await fetch(`${await worker()}/stats?ids=${ids.slice(0, 100).join(',')}`)) : {};

export const view = async (id: string): Promise<Stats> => read<Stats>(await fetch(`${await worker()}/view/${id}`, { method: 'POST' }));
export const vote = async (id: string, value: -1 | 0 | 1): Promise<Stats> => read<Stats>(await fetch(`${await worker()}/vote/${id}?value=${value}`, { method: 'POST' }));
export const myVote = async (id: string): Promise<number> => (await read<{ vote: number }>(await fetch(`${await worker()}/mine/${id}`))).vote;

/** Headers that prove who is calling: the admin's Google sign-in or hub key, or an uploader's edit token. */
export interface Credentials {
  readonly google?: string;
  readonly key?: string;
  readonly token?: string;
}
const headers = (who: Credentials): Record<string, string> => ({
  ...(who.google ? { authorization: `Bearer ${who.google}` } : {}),
  ...(who.key ? { 'x-hub-key': who.key } : {}),
  ...(who.token ? { 'x-edit-token': who.token } : {}),
});

export const call = async <T,>(path: string, who: Credentials, init: RequestInit = {}): Promise<T> =>
  read<T>(await fetch(`${await worker()}${path}`, { ...init, headers: { ...headers(who), ...(init.headers as Record<string, string> | undefined) } }));

/**
 * Uploads a .gcast: small files in one request, big ones straight to the hub storage in 8 MB pieces, so the page
 * shows real progress and a broken connection only repeats one piece.
 */
export const upload = async (file: File, query: URLSearchParams, who: Credentials, progress: (share: number) => void): Promise<Video & { token?: string }> => {
  const files = await worker();
  if (file.size <= 16 * 1048576) {
    const entry = await new Promise<Video & { token?: string }>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${files}/upload?${query}`);
      for (const [name, value] of Object.entries(headers(who))) request.setRequestHeader(name, value);
      request.upload.addEventListener('progress', (event) => progress(event.loaded / event.total));
      request.addEventListener('load', () => {
        const data = JSON.parse(request.responseText || '{}') as Video & { token?: string; error?: string };
        if (request.status >= 400) reject(new Error(data.error ?? `HTTP ${request.status}`));
        else resolve(data);
      });
      request.addEventListener('error', () => reject(new Error('Нет связи с хабом')));
      request.send(file);
    });
    return entry;
  }
  const started = await call<{ id: string; token: string; upload: string }>(`/parts/start?size=${file.size}`, who, { method: 'POST' });
  const piece = 32 * 262144;
  for (let offset = 0; offset < file.size; offset += piece) {
    const end = Math.min(file.size, offset + piece);
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(started.upload, { method: 'PUT', body: file.slice(offset, end), headers: { 'content-range': `bytes ${offset}-${end - 1}/${file.size}` } }).catch(() => null);
      if (response && (response.status === 308 || response.ok)) break;
      if (attempt >= 5) throw new Error('Хранилище не приняло файл, попробуйте ещё раз');
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
    progress(end / file.size);
  }
  return call<Video & { token?: string }>(`/parts/${started.id}/finish?${query}`, { ...who, token: started.token }, { method: 'POST' });
};

export const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

export const plural = (count: number, one: string, few: string, many: string): string => {
  const last = count % 10;
  const tens = count % 100;
  return last === 1 && tens !== 11 ? one : last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many;
};

export const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} МБ`;

declare global {
  interface Window {
    google?: { accounts: { id: { initialize: (options: { client_id: string; callback: (answer: { credential: string }) => void }) => void; renderButton: (node: HTMLElement, options: Record<string, unknown>) => void; disableAutoSelect: () => void } } };
  }
}

/** Google's sign-in script, loaded once. */
export const googleScript = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (window.google) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in did not load'));
    document.head.append(script);
  });


const GOOGLE = 'gcast-hub-google';

/** The Google ID token saved in this tab, if it has not expired yet. */
export const savedGoogle = (): string => {
  try {
    const token = sessionStorage.getItem(GOOGLE) ?? '';
    const payload = JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (payload.exp ?? 0) * 1000 > Date.now() + 60000 ? token : '';
  } catch {
    return '';
  }
};

export const saveGoogle = (token: string): void => {
  try {
    if (token) sessionStorage.setItem(GOOGLE, token);
    else sessionStorage.removeItem(GOOGLE);
  } catch {}
};

/** Draws Google's sign-in button into `node`; `signed` gets the ID token the worker checks with Google. */
export const googleButton = async (node: HTMLElement, signed: (token: string) => void): Promise<void> => {
  const [config] = await Promise.all([fetch('/hub.json').then((response) => response.json() as Promise<{ googleClientId?: string }>), googleScript()]);
  if (!config.googleClientId || !window.google) throw new Error('Google sign-in is not set up');
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: ({ credential }) => {
      saveGoogle(credential);
      signed(credential);
    },
  });
  window.google.accounts.id.renderButton(node, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ru', width: 300 });
};
