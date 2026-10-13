import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { catalog, fileUrl, meta, sources, view, worker, type Video } from './api';
import { Player } from './Player';

const style = document.createElement('style');
style.textContent = `html, body, #root { margin: 0; height: 100%; background: #000; color: #e8ecef; font: 13px "Onest", system-ui, sans-serif; overflow: hidden; }
glyph-player { position: absolute; inset: 0; --radius: 0; }
.brand { position: absolute; top: 10px; right: 12px; z-index: 1; padding: 3px 8px; border-radius: 6px; background: rgba(12, 15, 20, 0.8); color: #f0a04b; text-decoration: none; font: 700 12px "JetBrains Mono", monospace; opacity: 0.85; }
.brand:hover { opacity: 1; }
.missing { display: grid; place-items: center; height: 100%; color: #8b949e; }`;
document.head.append(style);

/** The player alone, for <iframe> embeds: ?v=<slug or id>. */
const Embed = () => {
  const key = new URLSearchParams(location.search).get('v') ?? '';
  const [files, setFiles] = useState('');
  const [video, setVideo] = useState<Video | null | undefined>(undefined);
  useEffect(() => {
    void worker().then(setFiles);
    void catalog()
      .then((list) => list.find((item) => item.slug === key || item.id === key) ?? (/^[\w-]{11}$/.test(key) ? meta(key) : null))
      .then((found) => {
        setVideo(found ?? null);
        if (found) document.title = `${found.title} · gcast hub`;
      })
      .catch(() => setVideo(null));
  }, [key]);
  if (video === null) return <div className="missing">Видео не найдено</div>;
  if (!video || !files) return null;
  return (
    <>
      <Player
        src={fileUrl(files, video, 'gcast')}
        sources={sources(files, video)}
        poster={video.poster ? fileUrl(files, video, 'jpg') : undefined}
        subtitles={video.subtitles ? fileUrl(files, video, 'vtt') : undefined}
        heading={video.title}
        source={video.source}
        fullsize=""
        onPlay={() => void view(video.id).catch(() => undefined)}
      />
      <a className="brand" href={new URL(`./?v=${encodeURIComponent(video.listed ? video.slug : video.id)}`, location.href).href} target="_blank" rel="noopener">
        gcast hub
      </a>
    </>
  );
};

createRoot(document.getElementById('root')!).render(<Embed />);
