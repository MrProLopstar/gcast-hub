import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { attributesOf, PLAYER_EVENTS } from './attributes.js';
const HANDLERS = { play: 'onPlay', pause: 'onPause', ended: 'onEnded', timeupdate: 'onTimeUpdate' };
/**
 * `<GlyphPlayer>` for React: the `<glyph-player>` element with typed props. The element is loaded in an effect,
 * so the component renders on the server too. The ref points to the element; `element.player` is the engine.
 *
 * ```tsx
 * import { GlyphPlayer } from 'glyphcast/react';
 *
 * <GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" onReady={(player) => player.play()} />
 * ```
 */
export const GlyphPlayer = forwardRef(function GlyphPlayer(props, ref) {
    const element = useRef(null);
    const latest = useRef(props);
    latest.current = props;
    useImperativeHandle(ref, () => element.current, []);
    useEffect(() => {
        let live = true;
        const listeners = [];
        void import('./element.js').then(() => {
            const node = element.current;
            if (!live || !node)
                return;
            const player = node.player;
            for (const type of PLAYER_EVENTS) {
                const listener = (event) => {
                    if (type === 'error')
                        latest.current.onError?.(event.detail);
                    else
                        latest.current[HANDLERS[type]]?.(player);
                };
                player.addEventListener(type, listener);
                listeners.push([type, listener]);
            }
            latest.current.onReady?.(player);
        });
        return () => {
            live = false;
            const player = element.current?.player;
            for (const [type, listener] of listeners)
                player?.removeEventListener(type, listener);
        };
    }, []);
    return createElement('glyph-player', { ref: element, class: props.className, style: props.style, ...attributesOf(props) });
});
//# sourceMappingURL=react.js.map