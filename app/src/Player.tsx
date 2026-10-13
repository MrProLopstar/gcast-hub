import 'glyphcast/element';
import { useEffect, useLayoutEffect, useRef } from 'react';

type Attributes = Partial<Record<'src' | 'sources' | 'poster' | 'subtitles' | 'heading' | 'source' | 'mode' | 'cols' | 'autoplay' | 'muted' | 'fullsize', string>>;
const NAMES = ['src', 'sources', 'poster', 'subtitles', 'heading', 'source', 'mode', 'cols', 'autoplay', 'muted', 'fullsize'] as const;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'glyph-player': React.HTMLAttributes<HTMLElement> & React.RefAttributes<HTMLElement>;
    }
  }
}

/**
 * The <glyph-player> element. Its settings are written as attributes by hand: React 19 would set them as
 * properties, which overwrites the element's own methods of the same names (poster, sources).
 */
export const Player = ({ onPlay, className, ...attributes }: Attributes & { onPlay?: () => void; className?: string }) => {
  const element = useRef<HTMLElement>(null);
  const all: Attributes = { mode: 'braille', cols: '160', ...attributes };
  const signature = JSON.stringify(all);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    for (const name of NAMES) {
      const value = all[name];
      if (value === undefined) node.removeAttribute(name);
      else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
  }, [signature]);
  useEffect(() => {
    const node = element.current;
    if (!node || !onPlay) return;
    const player = (node as HTMLElement & { player?: EventTarget }).player;
    player?.addEventListener('play', onPlay, { once: true });
    return () => player?.removeEventListener('play', onPlay);
  }, [onPlay, attributes.src]);
  return <glyph-player ref={element} className={className} />;
};
