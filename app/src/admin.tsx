import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call, clock, licenseName, megabytes, LICENSES, type Credentials, type Video } from './api';
import './hub.css';

const style = document.createElement('style');
style.textContent = `.admin { max-width: 1280px; margin: 0 auto; display: grid; gap: 16px; }
.admin table { width: 100%; border-collapse: collapse; font-size: 14px; }
.admin th, .admin td { padding: 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.admin th { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
.admin td input, .admin td select { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); }
.admin td input + input { margin-top: 6px; font-size: 12px; }
.admin .id { font: 12px var(--mono); color: var(--muted); margin-top: 4px; }
.admin .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); color: var(--muted); }
.admin .tag.open { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
.admin .tag.review { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.admin .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
.admin .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.admin .pages { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }`;
document.head.append(style);

type Filter = 'all' | 'review' | 'open' | 'link';
const FILTERS: [Filter, string][] = [
  ['all', 'Все'],
  ['review', 'На проверке'],
  ['open', 'В списке'],
  ['link', 'По ссылке'],
];
const PAGE = 50;

const Row = ({ video, who, reload, say }: { video: Video; who: Credentials; reload: () => void; say: (text: string) => void }) => {
  const [title, setTitle] = useState(video.title);
  const [source, setSource] = useState(video.source ?? '');
  const [license, setLicense] = useState(video.license);
  const [listed, setListed] = useState(video.listed);
  const [armed, setArmed] = useState(false);
  const save = async (override?: Partial<{ listed: boolean }>) => {
    try {
      const saved = await call<Video>(`/admin/videos/${video.id}`, who, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, source, license, listed, ...override }) });
      say(`Сохранено: ${saved.title}`);
      reload();
    } catch (error) {
      say(`Не сохранилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const remove = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    try {
      await call(`/admin/videos/${video.id}/delete`, who, { method: 'POST' });
      say('Удалено.');
      reload();
    } catch (error) {
      say(`Не удалилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const link = new URL(`./?v=${encodeURIComponent(video.listed ? video.slug : video.id)}`, location.href).href;
  return (
    <tr>
      <td style={{ minWidth: 260 }}>
        <input value={title} placeholder="Без названия" onChange={(event) => setTitle(event.target.value)} />
        <input value={source} placeholder="Ссылка на оригинал" onChange={(event) => setSource(event.target.value)} />
        <div className="id">
          <a href={link} target="_blank" rel="noopener">
            {video.id}
          </a>
        </div>
      </td>
      <td>
        {video.orphan ? <span className="tag review">без записи</span> : video.listed ? <span className="tag open">в списке</span> : <span className="tag">по ссылке</span>}
        {video.review && (
          <>
            {' '}
            <span className="tag review">просит в список</span>
          </>
        )}
        <label className="row" style={{ marginTop: 8, fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={listed} onChange={(event) => setListed(event.target.checked)} /> в списке
        </label>
      </td>
      <td style={{ minWidth: 150 }}>
        <select value={license} onChange={(event) => setLicense(event.target.value)}>
          {LICENSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </td>
      <td className="num">
        {clock(video.duration)}
        <div className="meta">{megabytes(video.files || video.size || 0)}</div>
      </td>
      <td className="num">
        {video.stats ? `${video.stats.views} просм.` : '—'}
        {video.stats && <div className="meta">+{video.stats.up} −{video.stats.down}</div>}
      </td>
      <td>
        <div className="row">
          {video.review && (
            <button type="button" className="button primary" onClick={() => void save({ listed: true })}>
              Одобрить
            </button>
          )}
          <button type="button" className="button" onClick={() => void save()}>
            Сохранить
          </button>
          <button type="button" className="button ghost" style={{ color: 'var(--danger)' }} onClick={() => void remove()}>
            {armed ? 'Точно?' : 'Удалить'}
          </button>
        </div>
      </td>
    </tr>
  );
};

const Admin = () => {
  const [key, setKey] = useState(() => {
    try {
      return localStorage.getItem('gcast-hub-key') ?? '';
    } catch {
      return '';
    }
  });
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const who: Credentials = { key };
  const load = async () => {
    try {
      localStorage.setItem('gcast-hub-key', key);
    } catch {}
    try {
      const { videos: list } = await call<{ videos: Video[] }>('/admin/videos', who);
      setVideos(list);
    } catch (error) {
      setVideos(null);
      setStatus(`Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  useEffect(() => {
    if (key) void load();
  }, []);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (videos ?? [])
      .filter((video) => filter === 'all' || (filter === 'review' ? video.review : filter === 'open' ? video.listed : !video.listed))
      .filter((video) => !text || video.title.toLowerCase().includes(text) || video.id.toLowerCase().includes(text))
      .sort((a, b) => Number(Boolean(b.review)) - Number(Boolean(a.review)) || b.added.localeCompare(a.added));
  }, [videos, filter, query]);
  useEffect(() => setPage(0), [filter, query]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const waiting = (videos ?? []).filter((video) => video.review).length;
  return (
    <>
      <header className="top">
        <a className="logo" href="./">
          gcast<b>hub</b>
        </a>
        <span className="meta">админка</span>
      </header>
      <main className="admin">
        <div className="row">
          <input type="password" className="field" style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', minWidth: 280 }} placeholder="Ключ хаба" value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load()} />
          <button type="button" className="button primary" onClick={() => void load()}>
            Войти
          </button>
          {status && <span className={status.startsWith('Не') ? 'error' : 'note'}>{status}</span>}
        </div>
        {videos && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="chips" style={{ margin: 0 }}>
                {FILTERS.map(([value, label]) => (
                  <button key={value} type="button" className="chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                    {label}
                    {value === 'review' && waiting ? ` · ${waiting}` : ''}
                  </button>
                ))}
              </div>
              <input type="search" placeholder="Название или id" value={query} onChange={(event) => setQuery(event.target.value)} style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--line)', background: 'var(--surface)', minWidth: 240 }} />
            </div>
            <div className="wrap">
              <table>
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Доступ</th>
                    <th>Лицензия</th>
                    <th>Длина</th>
                    <th>Статистика</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(page * PAGE, (page + 1) * PAGE).map((video) => (
                    <Row key={`${video.id}-${video.title}-${video.listed}`} video={video} who={who} reload={() => void load()} say={setStatus} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pages">
              <span className="meta">
                {shown.length} видео · {licenseName('own') && ''}страница {page + 1} из {pages}
              </span>
              <button type="button" className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Назад
              </button>
              <button type="button" className="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                Дальше
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<Admin />);
