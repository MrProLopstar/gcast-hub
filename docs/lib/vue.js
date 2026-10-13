import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { attributesOf, PLAYER_EVENTS } from './attributes.js';
/**
 * `<GlyphPlayer>` for Vue 3: the `<glyph-player>` element with typed props and events (`ready`, `play`, `pause`,
 * `ended`, `timeupdate`, `error`). The element is loaded on mount, so it renders on the server too.
 *
 * ```vue
 * <GlyphPlayer src="/movie.gcast" poster="/movie.jpg" mode="braille" @ready="(player) => player.play()" />
 * ```
 */
export const GlyphPlayer = defineComponent({
    name: 'GlyphPlayer',
    props: {
        src: String,
        audio: String,
        poster: String,
        subtitles: String,
        youtube: String,
        file: String,
        server: String,
        cols: Number,
        glyphs: String,
        tint: String,
        boost: Number,
        fill: Number,
        autoLevels: { type: Boolean, default: undefined },
        mode: String,
        edges: Boolean,
        crt: Boolean,
        autoPlay: Boolean,
        muted: Boolean,
        loop: Boolean,
    },
    emits: ['ready', ...PLAYER_EVENTS],
    setup(props, { emit, expose }) {
        const element = ref(null);
        const listeners = [];
        expose({ element });
        onMounted(async () => {
            await import('./element.js');
            const player = element.value?.player;
            if (!player)
                return;
            for (const type of PLAYER_EVENTS) {
                const listener = (event) => emit(type, type === 'error' ? event.detail : player);
                player.addEventListener(type, listener);
                listeners.push([type, listener]);
            }
            emit('ready', player);
        });
        onBeforeUnmount(() => {
            const player = element.value?.player;
            for (const [type, listener] of listeners)
                player?.removeEventListener(type, listener);
        });
        return () => h('glyph-player', { ref: element, ...attributesOf(props) });
    },
});
//# sourceMappingURL=vue.js.map