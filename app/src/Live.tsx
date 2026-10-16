import { Encoder } from 'glyphcast';
import { useEffect, useRef, useState } from 'react';
import { Player } from './Player';

interface Broadcast {
  readonly socket: WebSocket;
  readonly media: MediaStream;
  readonly timer: ReturnType<typeof setInterval>;
}

/** Turns the camera or the screen into glyphs in the browser and sends them to viewers of a room. */
export const Live = ({ files, close }: { files: string; close: () => void }) => {
  const [room, setRoom] = useState('live');
  const [status, setStatus] = useState('');
  const [link, setLink] = useState('');
  const current = useRef<Broadcast | null>(null);
  const stop = () => {
    const live = current.current;
    if (!live) return;
    clearInterval(live.timer);
    live.socket.close();
    for (const track of live.media.getTracks()) track.stop();
    current.current = null;
    setLink('');
    setStatus('Эфир остановлен.');
  };
  useEffect(() => () => stop(), []);
  const start = async (screen: boolean) => {
    stop();
    if (!/^[\w-]{1,40}$/.test(room)) {
      setStatus('Название: латинские буквы, цифры, дефис, до 40 символов.');
      return;
    }
    // a secret of this browser: while the broadcast runs, nobody else can take the room
    let token = '';
    try {
      token = localStorage.getItem('gcast-live-token') ?? '';
      if (!token) {
        token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('gcast-live-token', token);
      }
    } catch {
      token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    try {
      const media = screen ? await navigator.mediaDevices.getDisplayMedia({ video: true }) : await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = media;
      await video.play();
      const cols = 160;
      const fps = 15;
      const rows = Math.max(1, Math.round(cols * (video.videoHeight / video.videoWidth) * 0.6));
      const canvas = new OffscreenCanvas(cols, rows);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const socket = new WebSocket(`${files.replace(/^http/, 'ws')}/live/${room}/broadcast?token=${token}`);
      socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('в этой комнате уже идёт чужой эфир, выберите другое название')), { once: true });
      });
      const encoder = new Encoder({ cols, rows, fps, chunkFrames: fps, fast: true }, (bytes) => socket.readyState === 1 && socket.send(bytes));
      const timer = setInterval(() => {
        if (!context) return;
        context.drawImage(video, 0, 0, cols, rows);
        encoder.add(context.getImageData(0, 0, cols, rows).data);
      }, 1000 / fps);
      current.current = { socket, media, timer };
      socket.addEventListener('close', stop);
      for (const track of media.getVideoTracks()) track.addEventListener('ended', stop);
      setLink(new URL(`?live=${room}`, location.href).href);
      setStatus('В эфире.');
    } catch (error) {
      stop();
      setStatus(`Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Прямой эфир" onClick={(event) => event.target === event.currentTarget && close()}>
      <div className="panel">
        <h2>Прямой эфир</h2>
        <p className="note">Камера или экран превращаются в символы прямо в браузере и уходят зрителям: на сайт и в терминал.</p>
        <label className="field">
          Название эфира
          <input value={room} onChange={(event) => setRoom(event.target.value)} />
        </label>
        <div className="row">
          <button type="button" className="button primary" onClick={() => void start(false)}>
            Камера
          </button>
          <button type="button" className="button" onClick={() => void start(true)}>
            Экран
          </button>
          <button type="button" className="button ghost" disabled={!link} onClick={stop}>
            Остановить
          </button>
        </div>
        {status && <p className={status.startsWith('Не') ? 'error' : 'note'}>{status}</p>}
        {link && (
          <p className="note">
            Смотреть: <a href={link}>{link}</a> или <code>npx glyphcast play live:{room}</code>
          </p>
        )}
        <div className="row">
          <button type="button" className="button ghost" onClick={close}>
            Свернуть
          </button>
        </div>
      </div>
    </div>
  );
};

export const LiveWatch = ({ room, files }: { room: string; files: string }) => {
  useEffect(() => {
    document.title = `Эфир ${room} · gcast hub`;
  }, [room]);
  if (!/^[\w-]{1,40}$/.test(room)) return <main className="empty">Такого эфира нет.</main>;
  return (
    <main className="watch">
      <section>
        <Player src={`${files}/live/${room}.gcast`} autoplay="" muted="" heading={`Эфир: ${room}`} />
        <h1>Прямой эфир: {room}</h1>
        <div className="about">
          <div className="meta">Если эфир ещё не начался, обновите страницу, когда он стартует.</div>
          <div className="meta">
            В терминале: <code>npx glyphcast play live:{room}</code>
          </div>
        </div>
      </section>
    </main>
  );
};
