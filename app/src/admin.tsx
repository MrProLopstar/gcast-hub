import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call, clock, fileUrl, megabytes, worker, LICENSES, type Credentials, type Video } from './api';
import './hub.css';
import './admin.css';
import { Player } from './Player';
import { sources } from './api';

/** What each license lets people do, in plain words, shown next to the choice. */
const ABOUT: Record<string, string> = {
  own: 'Все права у автора. Без вашего решения видео открывается только по ссылке; в общий список его можно поставить вручную, но при претензии правообладателя придётся убрать.',
  CC0: 'Автор отказался от всех прав: можно копировать, менять и использовать как угодно, даже без указания автора.',
  'CC-BY': 'Можно копировать, менять и использовать, в том числе в коммерции, если указан автор. Так лицензированы фильмы Blender.',
  'CC-BY-SA': 'Как CC BY, но изменённые версии нужно выпускать под той же лицензией.',
  'CC-BY-NC': 'Можно копировать и менять с указанием автора, но только некоммерчески.',
  'public-domain': 'Срок охраны истёк или права не возникали (старые фильмы, госматериалы некоторых стран): свободно для всех.',
};

type Filter = 'all' | 'review' | 'open' | 'link';
const FILTERS: [Filter, string][] = [
  ['all', 'Все'],
  ['review', 'На проверке'],
  ['open', 'В списке'],
  ['link', 'По ссылке'],
];
const PAGE = 40;

const Item = ({ video, files, who, reload, say, watch }: { video: Video; files: string; who: Credentials; reload: () => void; say: (text: string) => void; watch: (video: Video) => void }) => {
  const [title, setTitle] = useState(video.title);
  const [source, setSource] = useState(video.source ?? '');
  const [description, setDescription] = useState(video.description ?? '');
  const [license, setLicense] = useState(video.license);
  const [listed, setListed] = useState(video.listed);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = title !== video.title || description !== (video.description ?? '') || source !== (video.source ?? '') || license !== video.license || listed !== video.listed;
  const save = async (override?: Partial<{ listed: boolean }>) => {
    setBusy(true);
    try {
      const saved = await call<Video>(`/admin/videos/${video.id}`, who, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description, source, license, listed, ...override }) });
      say(`Сохранено: «${saved.title}»`);
      reload();
    } catch (error) {
      say(`Не сохранилось: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setBusy(true);
    try {
      await call(`/admin/videos/${video.id}/delete`, who, { method: 'POST' });
      say(`Удалено: «${video.title || video.id}»`);
      reload();
    } catch (error) {
      say(`Не удалилось: ${error instanceof Error ? error.message : String(error)}`);
      setBusy(false);
    }
  };
  const link = new URL(`./?v=${encodeURIComponent(video.id)}`, location.href).href;
  return (
    <article className={`item${video.review ? ' waiting' : ''}`}>
      <button type="button" className="poster" aria-label="Предпросмотр" onClick={() => watch(video)}>
        {video.poster ? <img loading="lazy" alt="" src={fileUrl(files, video, 'jpg')} /> : <span>⣿⡇⠶</span>}
        <time>{clock(video.duration)}</time>
        <span className="play" aria-hidden="true">▶</span>
      </button>
      <div className="fields">
        <input className="title" value={title} placeholder="Без названия" aria-label="Название" onChange={(event) => setTitle(event.target.value)} />
        <textarea rows={2} value={description} placeholder="Описание" aria-label="Описание" onChange={(event) => setDescription(event.target.value)} />
        <input value={source} placeholder="Ссылка на оригинал" aria-label="Ссылка на оригинал" onChange={(event) => setSource(event.target.value)} />
        <div className="facts">
          {video.orphan ? <span className="pill warn">без записи</span> : video.listed ? <span className="pill good">в списке</span> : <span className="pill">по ссылке</span>}
          {video.review && <span className="pill warn">просит в список</span>}
          {!video.orphan && !video.files && <span className="pill bad">нет файла</span>}
          <span>{megabytes(video.files || video.size || 0)}</span>
          <span>
            {video.cols}×{video.rows}
          </span>
          <span>{video.added}</span>
          <a className="mono" href={link} target="_blank" rel="noopener">
            {video.id} ↗
          </a>
        </div>
      </div>
      <div className="license">
        <select value={license} aria-label="Лицензия" onChange={(event) => setLicense(event.target.value)}>
          {LICENSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p>{ABOUT[license]}</p>
        <label className="switch">
          <input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} /> показывать в общем списке
        </label>
      </div>
      <div className="numbers">
        <strong>{video.stats?.views ?? 0}</strong>
        <span>просмотров</span>
        <span className="votes-line">
          <b className="up">+{video.stats?.up ?? 0}</b> <b className="down">−{video.stats?.down ?? 0}</b>
        </span>
      </div>
      <div className="buttons">
        {video.review && (
          <button type="button" className="button primary" disabled={busy} onClick={() => void save({ listed: true })}>
            Одобрить
          </button>
        )}
        <button type="button" className="button" disabled={busy || !changed} onClick={() => void save()}>
          Сохранить
        </button>
        <button type="button" className={`button ghost danger${armed ? ' armed' : ''}`} disabled={busy} onClick={() => void remove()}>
          {armed ? 'Точно удалить?' : 'Удалить'}
        </button>
      </div>
    </article>
  );
};

declare global {
  interface Window {
    google?: { accounts: { id: { initialize: (options: { client_id: string; callback: (answer: { credential: string }) => void }) => void; renderButton: (node: HTMLElement, options: Record<string, unknown>) => void; disableAutoSelect: () => void } } };
  }
}

/** Google's sign-in script, loaded once. */
const googleScript = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (window.google) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in did not load'));
    document.head.append(script);
  });

const Admin = () => {
  const [files, setFiles] = useState('');
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [legend, setLegend] = useState(false);
  const [watching, setWatching] = useState<Video | null>(null);
  const [google, setGoogle] = useState(() => {
    try {
      return sessionStorage.getItem('gcast-hub-google') ?? '';
    } catch {
      return '';
    }
  });
  const button = useRef<HTMLDivElement>(null);
  const who: Credentials = { google };
  const load = async (as: Credentials = who) => {
    try {
      const { videos: list } = await call<{ videos: Video[] }>('/admin/videos', as);
      setVideos(list);
      setStatus('');
    } catch (error) {
      setVideos(null);
      const denied = error instanceof Error && /admin|key/i.test(error.message);
      if (denied && as.google) {
        setGoogle('');
        try {
          sessionStorage.removeItem('gcast-hub-google');
        } catch {}
      }
      setStatus(denied ? 'Этот аккаунт Google не админ хаба, или вход устарел — войдите ещё раз.' : `Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  useEffect(() => {
    document.title = 'Админка · gcast hub';
    void worker().then(setFiles);
    if (google) void load();
  }, []);
  useEffect(() => {
    if (videos) return;
    let cancelled = false;
    // the Google button: its answer is an ID token that the worker checks with Google
    void Promise.all([fetch('/hub.json').then((response) => response.json() as Promise<{ googleClientId?: string }>), googleScript()])
      .then(([config]) => {
        if (cancelled || !config.googleClientId || !button.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: ({ credential }) => {
            setGoogle(credential);
            try {
              sessionStorage.setItem('gcast-hub-google', credential);
            } catch {}
            void load({ google: credential });
          },
        });
        window.google.accounts.id.renderButton(button.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ru', width: 320 });
      })
      .catch(() => setStatus('Вход через Google сейчас недоступен, попробуйте обновить страницу.'));
    return () => {
      cancelled = true;
    };
  }, [videos]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (videos ?? [])
      .filter((video) => filter === 'all' || (filter === 'review' ? video.review : filter === 'open' ? video.listed : !video.listed))
      .filter((video) => !text || video.title.toLowerCase().includes(text) || video.id.toLowerCase().includes(text))
      .sort((a, b) => Number(Boolean(b.review)) - Number(Boolean(a.review)) || b.added.localeCompare(a.added));
  }, [videos, filter, query]);
  useEffect(() => setPage(0), [filter, query]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  /** Takes every listed video without an open license off the open list, for a takedown request. */
  const hideOwn = async () => {
    const targets = (videos ?? []).filter((video) => video.listed && video.license === 'own');
    for (const [at, video] of targets.entries()) {
      setStatus(`Скрываю ${at + 1} из ${targets.length}…`);
      await call(`/admin/videos/${video.id}`, who, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listed: false }) }).catch(() => undefined);
    }
    setStatus(`Скрыто из общего списка: ${targets.length}`);
    void load();
  };
  const all = videos ?? [];
  const totals = {
    count: all.length,
    review: all.filter((video) => video.review).length,
    open: all.filter((video) => video.listed).length,
    views: all.reduce((sum, video) => sum + (video.stats?.views ?? 0), 0),
    size: all.reduce((sum, video) => sum + (video.files || video.size || 0), 0),
  };
  if (!videos)
    return (
      <div className="login">
        <div className="panel">
          <a className="logo" href="./">
            gcast<b>hub</b>
          </a>
          <h2>Вход в админку</h2>
          <div ref={button} className="google" />
          {status && <p className="error">{status}</p>}
          <p className="note">Пускает только аккаунт Google админа хаба.</p>
        </div>
      </div>
    );
  return (
    <>
      <header className="top">
        <a className="logo" href="./">
          gcast<b>hub</b>
        </a>
        <span className="meta">админка</span>
        <nav className="actions" style={{ marginLeft: 'auto' }}>
          <button type="button" className="button" aria-expanded={legend} onClick={() => setLegend(!legend)}>
            Лицензии
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              try {
                sessionStorage.removeItem('gcast-hub-google');
              } catch {}
              window.google?.accounts.id.disableAutoSelect();
              setGoogle('');
              setVideos(null);
            }}
          >
            Выйти
          </button>
        </nav>
      </header>
      <main className="admin">
        <section className="totals" aria-label="Итоги">
          <div>
            <strong>{totals.count}</strong>
            <span>видео</span>
          </div>
          <div className={totals.review ? 'attention' : ''}>
            <strong>{totals.review}</strong>
            <span>ждут проверки</span>
          </div>
          <div>
            <strong>{totals.open}</strong>
            <span>в общем списке</span>
          </div>
          <div>
            <strong>{totals.views}</strong>
            <span>просмотров</span>
          </div>
          <div>
            <strong>{megabytes(totals.size)}</strong>
            <span>на Диске</span>
          </div>
        </section>
        {legend && (
          <section className="legend" aria-label="Что значат лицензии">
            {LICENSES.map(([value, label]) => (
              <div key={value}>
                <strong>{label}</strong>
                <p>{ABOUT[value]}</p>
              </div>
            ))}
            <p className="note">Ролики с лицензией «Все права у автора», поставленные в общий список, можно разом убрать кнопкой «Скрыть несвободные», если придут претензии.</p>
          </section>
        )}
        <div className="toolbar">
          <div className="chips">
            {FILTERS.map(([value, label]) => (
              <button key={value} type="button" className="chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
                {value === 'review' && totals.review ? ` · ${totals.review}` : ''}
              </button>
            ))}
          </div>
          <button type="button" className="button ghost danger" disabled={!all.some((video) => video.listed && video.license === 'own')} onClick={() => void hideOwn()}>
            Скрыть несвободные
          </button>
          <input type="search" className="find" placeholder="Название или id" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {status && <p className={status.startsWith('Не') ? 'error' : 'note'}>{status}</p>}
        <div className="items">
          {shown.length === 0 && <p className="empty">Ничего не нашлось.</p>}
          {shown.slice(page * PAGE, (page + 1) * PAGE).map((video) => (
            <Item key={`${video.id}-${video.title}-${video.listed}-${video.license}-${video.source ?? ''}-${video.description ?? ''}`} video={video} files={files} who={who} reload={() => void load()} say={setStatus} watch={setWatching} />
          ))}
        </div>
        {pages > 1 && (
          <div className="pages">
            <button type="button" className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Назад
            </button>
            <span className="meta">
              {page + 1} из {pages}
            </span>
            <button type="button" className="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              Дальше
            </button>
          </div>
        )}
      </main>
      {watching && (
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Предпросмотр" onClick={(event) => event.target === event.currentTarget && setWatching(null)}>
          <div className="panel preview">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{watching.title || watching.id}</h2>
              <button type="button" className="button ghost" onClick={() => setWatching(null)}>
                Закрыть
              </button>
            </div>
            <Player
              src={fileUrl(files, watching, 'gcast')}
              sources={sources(files, watching)}
              poster={watching.poster ? fileUrl(files, watching, 'jpg') : undefined}
              subtitles={watching.subtitles ? fileUrl(files, watching, 'vtt') : undefined}
              heading={watching.title}
              source={watching.source}
            />
          </div>
        </div>
      )}
    </>
  );
};

createRoot(document.getElementById('root')!).render(<Admin />);
