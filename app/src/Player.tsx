import 'glyphcast/element';
import { useEffect, useRef } from 'react';

type Attributes = Partial<Record<'src' | 'sources' | 'poster' | 'subtitles' | 'heading' | 'source' | 'mode' | 'cols' | 'autoplay' | 'muted' | 'fullsize', string>>;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'glyph-player': React.HTMLAttributes<HTMLElement> & React.RefAttributes<HTMLElement> & Record<string, unknown>;
    }
  }
}

/** The <glyph-player> element with its attributes from props; \`onPlay\` fires once playback starts. */
export const Player = ({ onPlay, className, ...attributes }: Attributes & { onPlay?: () => void; className?: string }) => {
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node || !onPlay) return;
    const player = (node as HTMLElement & { player?: EventTarget }).player;
    player?.addEventListener('play', onPlay, { once: true });
    return () => player?.removeEventListener('play', onPlay);
  }, [onPlay, attributes.src]);
  const set = Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined));
  return <glyph-player ref={element} class={className} mode="braille" cols="160" {...set} />;
};
