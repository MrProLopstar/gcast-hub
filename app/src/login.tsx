import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { googleButton } from './api';
import './hub.css';

/**
 * Sign-in for the terminal: `glc login` opens this page with ?port=<n> and waits on 127.0.0.1:<n>. After the Google
 * sign-in the page hands the ID token to that local address only, and glc uploads with it.
 */
const Login = () => {
  const port = Number(new URLSearchParams(location.search).get('port'));
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const button = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(valid ? '' : 'Эту страницу открывает команда glc login.');
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!valid || !button.current) return;
    googleButton(button.current, (token) => {
      fetch(`http://127.0.0.1:${port}/token`, { method: 'POST', body: token })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          setDone(true);
        })
        .catch(() => setStatus('Не удалось передать вход в терминал: команда glc login уже закрыта? Запустите её ещё раз.'));
    }).catch(() => setStatus('Вход через Google сейчас недоступен, обновите страницу.'));
  }, []);
  return (
    <div className="login">
      <div className="panel">
        <a className="logo" href="./">
          gcast<b>hub</b>
        </a>
        <h2>Вход для glc</h2>
        {done ? (
          <p>Готово. Вернитесь в терминал, эту вкладку можно закрыть.</p>
        ) : (
          <>
            {valid && <p>Войдите через Google, и терминал сможет загружать видео в хаб от вашего имени.</p>}
            <div ref={button} className="google" />
          </>
        )}
        {status && <p className="error">{status}</p>}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root') as HTMLElement).render(<Login />);
