import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { catalog, clock, fileUrl, licenseName, megabytes, meta, myVote, plural, sources, stats, upload, view, vote, worker, LICENSES, type Stats, type Video } from './api';
import { Player } from './Player';
import { Live, LiveWatch } from './Live';
import './hub.css';

const views = (count: number): string => `${count} ${plural(count, 'просмотр', 'просмотра', 'просмотров')}`;
const ago = (date: string): string => {
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days < 1) return 'сегодня';
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} ${plural(months, 'месяц', 'месяца', 'месяцев')} назад` : `${Math.floor(months / 12)} г. назад`;
};

type Route = { page: 'home'; query: string } | { page: 'watch'; key: string } | { page: 'live'; room: string };
const readRoute = (): Route => {
  const params = new URLSearchParams(location.search);
  const key = params.get('v');
  if (key) return { page: 'watch', key };
  const room = params.get('live');
  if (room) return { page: 'live', room };
  return { page: 'home', query: params.get('q') ?? '' };
};
const go = (search: string): void => {
  history.pushState(null, '', search || location.pathname);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo({ top: 0 });
};

const Card = ({ video, files, stat }: { video: Video; files: string; stat?: Stats }) => (
  <a
    className="card"
    href={`?v=${encodeURIComponent(video.listed ? video.slug : video.id)}`}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      go(`?v=${encodeURIComponent(video.listed ? video.slug : video.id)}`);
    }}
  >
    <div className="thumb">
      {video.poster ? <img loading="lazy" alt="" src={fileUrl(files, video, 'jpg')} /> : <div className="glyphs">⣿⡇⠶</div>}
      <time>{clock(video.duration)}</time>
    </div>
    <div>
      <h3>{video.title}</h3>
      <div className="meta">
        {stat ? `${views(stat.views)} · ` : ''}
        {ago(video.added)}
      </div>
    </div>
  </a>
);

/** Shows cards a page at a time; the next page loads when the end of the list scrolls into view. */
const Grid = ({ videos, files, className = 'grid' }: { videos: Video[]; files: string; className?: string }) => {
  const [count, setCount] = useState(24);
  const [numbers, setNumbers] = useState<Record<string, Stats>>({});
  const shown = videos.slice(0, count);
  useEffect(() => setCount(24), [videos]);
  useEffect(() => {
    const missing = shown.filter((video) => !numbers[video.id]).map((video) => video.id);
    if (missing.length) void stats(missing).then((found) => setNumbers((old) => ({ ...old, ...found }))).catch(() => undefined);
  }, [shown.length, videos]);
  const sentinel = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setCount((value) => value + 24), { rootMargin: '600px' });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [videos],
  );
  if (!videos.length) return <p className="empty">Видео пока нет.</p>;
  return (
    <>
      <div className={className}>
        {shown.map((video) => (
          <Card key={video.id} video={video} files={files} stat={numbers[video.id]} />
        ))}
      </div>
      {count < videos.length && <div ref={sentinel} style={{ height: 1 }} />}
    </>
  );
};

type Sort = 'new' | 'views' | 'top' | 'long';
const SORTS: [Sort, string][] = [
  ['new', 'Новые'],
  ['views', 'Популярные'],
  ['top', 'Лучшие оценки'],
  ['long', 'Длинные'],
];

const Home = ({ videos, files, query }: { videos: Video[]; files: string; query: string }) => {
  const [sort, setSort] = useState<Sort>('new');
  const [numbers, setNumbers] = useState<Record<string, Stats>>({});
  useEffect(() => {
    if (sort === 'views' || sort === 'top') void stats(videos.map((video) => video.id)).then(setNumbers).catch(() => undefined);
  }, [sort, videos]);
  const list = useMemo(() => {
    const text = query.trim().toLowerCase();
    const found = videos.filter((video) => !text || video.title.toLowerCase().includes(text));
    const score = (video: Video): number => {
      const stat = numbers[video.id];
      if (sort === 'views') return stat?.views ?? 0;
      if (sort === 'top') return (stat?.up ?? 0) - (stat?.down ?? 0);
      if (sort === 'long') return video.duration;
      return new Date(video.added).getTime();
    };
    return [...found].sort((a, b) => score(b) - score(a));
  }, [videos, query, sort, numbers]);
  return (
    <main>
      <div className="chips" role="group" aria-label="Порядок">
        {SORTS.map(([value, label]) => (
          <button key={value} type="button" className="chip" aria-pressed={sort === value} onClick={() => setSort(value)}>
            {label}
          </button>
        ))}
      </div>
      {query && <p className="meta">Найдено: {list.length}</p>}
      <Grid videos={list} files={files} />
    </main>
  );
};

const Watch = ({ key$, videos, files }: { key$: string; videos: Video[]; files: string }) => {
  const listed = videos.find((video) => video.slug === key$ || video.id === key$);
  const [video, setVideo] = useState<Video | null | undefined>(listed);
  const [stat, setStat] = useState<Stats>({ views: 0, up: 0, down: 0 });
  const [mine, setMine] = useState(0);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (listed) setVideo(listed);
    else if (/^[\w-]{11}$/.test(key$)) void meta(key$).then(setVideo);
    else setVideo(null);
  }, [key$, listed]);
  useEffect(() => {
    if (!video) return;
    document.title = `${video.title} · gcast hub`;
    void stats([video.id]).then((found) => found[video.id] && setStat(found[video.id]!)).catch(() => undefined);
    void myVote(video.id).then(setMine).catch(() => undefined);
  }, [video?.id]);
  const counted = useCallback(() => {
    if (video) void view(video.id).then(setStat).catch(() => undefined);
  }, [video?.id]);
  if (video === undefined) return <main className="empty">Загружаю…</main>;
  if (video === null) return <main className="empty">Такого видео нет.</main>;
  const name = video.listed ? video.slug : video.id;
  const page = new URL(`?v=${encodeURIComponent(name)}`, location.href).href;
  const embed = `<iframe src="${new URL(`embed.html?v=${encodeURIComponent(name)}`, location.href).href}" width="800" height="450" allow="fullscreen; picture-in-picture; autoplay" style="border:0;border-radius:12px"></iframe>`;
  const copy = (text: string, what: string) => () => void navigator.clipboard.writeText(text).then(() => {
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  });
  const cast = (value: 1 | -1) => () => {
    const next = mine === value ? 0 : value;
    void vote(video.id, next as -1 | 0 | 1).then((found) => {
      setStat(found);
      setMine(found.mine ?? next);
    });
  };
  const more = videos.filter((item) => item.id !== video.id);
  return (
    <main className="watch">
      <section>
        <Player
          key={video.id}
          src={fileUrl(files, video, 'gcast')}
          sources={sources(files, video)}
          poster={video.poster ? fileUrl(files, video, 'jpg') : undefined}
          subtitles={video.subtitles ? fileUrl(files, video, 'vtt') : undefined}
          heading={video.title}
          source={video.source}
          onPlay={counted}
        />
        <h1>{video.title}</h1>
        <div className="bar">
          <div className="meta">
            {views(stat.views)} · {ago(video.added)} · <span className="badge">{licenseName(video.license)}</span>
          </div>
          <div className="row">
            <span className="votes" title="Как видео смотрится в символах">
              <button type="button" aria-pressed={mine === 1} onClick={cast(1)}>
                + {stat.up}
              </button>
              <button type="button" aria-pressed={mine === -1} onClick={cast(-1)}>
                − {stat.down}
              </button>
            </span>
            <button type="button" className="button" onClick={copy(page, 'link')}>
              {copied === 'link' ? 'Скопировано' : 'Поделиться'}
            </button>
            <button type="button" className="button" onClick={copy(embed, 'embed')}>
              {copied === 'embed' ? 'Скопировано' : 'Встроить'}
            </button>
          </div>
        </div>
        <div className="about">
          <div className="meta">
            {clock(video.duration)} · {video.cols}×{video.rows} символов · {megabytes(video.size)}
            {video.listed ? '' : ' · не в общем списке'}
          </div>
          {video.source && (
            <div>
              Оригинал:{' '}
              <a href={video.source} target="_blank" rel="noopener noreferrer">
                {new URL(video.source).hostname}
              </a>
            </div>
          )}
          <div className="meta">
            В терминале: <code>npx glyphcast play hub:{name}</code>
          </div>
        </div>
      </section>
      <aside className="side" aria-label="Ещё видео">
        <Grid videos={more} files={files} className="side" />
      </aside>
    </main>
  );
};

const Upload = ({ close, done }: { close: () => void; done: (video: Video) => void }) => {
  const [file, setFile] = useState<File | null>(null);
  const [poster, setPoster] = useState<File | null>(null);
  const [captions, setCaptions] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [license, setLicense] = useState('own');
  const [source, setSource] = useState('');
  const [share, setShare] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const send = async () => {
    if (!file || !title.trim()) return;
    setShare(0);
    setStatus('');
    try {
      const query = new URLSearchParams({ title: title.trim(), license, listed: license === 'own' ? '0' : '1' });
      if (source.trim()) query.set('source', source.trim());
      const entry = await upload(file, query, {}, setShare);
      const who = { token: entry.token ?? '' };
      const files = await worker();
      const extra = async (path: string, body: File, type: string) => {
        const response = await fetch(`${files}${path}`, { method: 'POST', body, headers: { 'x-edit-token': who.token, 'content-type': type } });
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
      };
      if (poster) await extra(`/poster/${entry.id}`, poster, 'image/jpeg');
      if (captions) await extra(`/subtitles/${entry.id}`, captions, 'text/vtt');
      setStatus(entry.review ? 'Готово. После проверки видео появится в общем списке, по ссылке оно уже открывается.' : 'Готово.');
      done({ ...entry, poster: Boolean(poster), subtitles: Boolean(captions) });
    } catch (error) {
      setStatus(`Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setShare(null);
    }
  };
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Загрузка видео" onClick={(event) => event.target === event.currentTarget && share === null && close()}>
      <div className="panel">
        <h2>Загрузить видео</h2>
        <p className="note">
          Нужен готовый <code>.gcast</code>: сделайте его в <a href="https://gcast.1lop.ru/">конвертере</a> или командой <code>npx glyphcast encode видео.mp4 --detail --embed --poster</code>.
        </p>
        <label className="field">
          Файл .gcast
          <input
            type="file"
            accept=".gcast"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null;
              setFile(picked);
              if (picked && !title) setTitle(picked.name.replace(/\.gcast$/i, ''));
            }}
          />
        </label>
        <label className="field">
          Название
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          Лицензия
          <select value={license} onChange={(event) => setLicense(event.target.value)}>
            {LICENSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Ссылка на оригинал (необязательно)
          <input type="url" value={source} placeholder="https://youtube.com/…" onChange={(event) => setSource(event.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            Постер .jpg
            <input type="file" accept="image/jpeg" onChange={(event) => setPoster(event.target.files?.[0] ?? null)} />
          </label>
          <label className="field">
            Субтитры .vtt
            <input type="file" accept=".vtt" onChange={(event) => setCaptions(event.target.files?.[0] ?? null)} />
          </label>
        </div>
        {share !== null && (
          <div className="progress" aria-label="Загрузка">
            <div style={{ width: `${(share * 100).toFixed(1)}%` }} />
          </div>
        )}
        {status && <p className={status.startsWith('Не') ? 'error' : 'note'}>{status}</p>}
        <div className="row">
          <button type="button" className="button primary" disabled={!file || !title.trim() || share !== null} onClick={() => void send()}>
            {share === null ? 'Опубликовать' : `Загрузка ${Math.round(share * 100)}%`}
          </button>
          <button type="button" className="button ghost" disabled={share !== null} onClick={close}>
            Закрыть
          </button>
        </div>
        <p className="note">Видео со свободной лицензией попадают в общий список после проверки, остальные открываются по ссылке.</p>
      </div>
    </div>
  );
};

const App = () => {
  const [route, setRoute] = useState<Route>(readRoute);
  const [videos, setVideos] = useState<Video[]>([]);
  const [files, setFiles] = useState('');
  const [dialog, setDialog] = useState<'upload' | 'live' | null>(null);
  const [text, setText] = useState(route.page === 'home' ? route.query : '');
  useEffect(() => {
    const update = () => setRoute(readRoute());
    addEventListener('popstate', update);
    void worker().then(setFiles);
    void catalog().then(setVideos).catch(() => setVideos([]));
    return () => removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    if (route.page === 'home') document.title = 'gcast hub';
  }, [route]);
  return (
    <>
      <header className="top">
        <a
          className="logo"
          href="./"
          onClick={(event) => {
            event.preventDefault();
            setText('');
            go('');
          }}
        >
          gcast<b>hub</b>
        </a>
        <form
          className="search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            go(text.trim() ? `?q=${encodeURIComponent(text.trim())}` : '');
          }}
        >
          <input type="search" aria-label="Поиск" placeholder="Поиск" value={text} onChange={(event) => setText(event.target.value)} />
          <button type="submit" aria-label="Найти">
            ⌕
          </button>
        </form>
        <nav className="actions">
          <button type="button" className="button" onClick={() => setDialog('live')}>
            <span aria-hidden="true">●</span>
            <span className="label">Эфир</span>
          </button>
          <button type="button" className="button primary" onClick={() => setDialog('upload')}>
            +<span className="label"> Загрузить</span>
          </button>
        </nav>
      </header>
      {files && route.page === 'home' && <Home videos={videos} files={files} query={route.query} />}
      {files && route.page === 'watch' && <Watch key$={route.key} videos={videos} files={files} />}
      {files && route.page === 'live' && <LiveWatch room={route.room} files={files} />}
      {dialog === 'upload' && (
        <Upload
          close={() => setDialog(null)}
          done={(video) => {
            if (video.listed) setVideos((old) => [video, ...old]);
          }}
        />
      )}
      {dialog === 'live' && files && <Live files={files} close={() => setDialog(null)} />}
    </>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
