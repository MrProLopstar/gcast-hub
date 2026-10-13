import { audioType, decodeChunkMotion, GlyphcastError, interpolate, indexLength, INDEX_TRAILER, readIndex, StreamReader } from './format.js';
import { autoLevels, ease, NEUTRAL } from './levels.js';
import { captionAt, parseCaptions } from './captions.js';
import { DEFAULT_GLYPHS, GlyphRenderer } from './renderer.js';
import { upscale2x } from './upscale.js';
/** Picks the source type from a URL: `.gcast` files are streams, everything else is video. */
export const sourceFor = (src, audio) => /\.gcast(?:$|[?#])/i.test(src) ? { type: 'gcast', src, ...(audio ? { audio } : {}) } : { type: 'video', src };
const AHEAD = 20;
/**
 * A glyph player without UI: give it a canvas and a source, call `play()`. It plays videos, cameras and `.gcast`
 * streams with the same API as a media element (`play`, `pause`, `currentTime`, `duration`, `volume`, `muted`,
 * `playbackRate`) and the same events (`play`, `pause`, `timeupdate`, `durationchange`, `progress`, `ended`,
 * `waiting`, `playing`, `error`, `loadedmetadata`).
 */
export class GlyphPlayer extends EventTarget {
    canvas;
    renderer;
    /** The media element that holds video and audio. Hidden; the canvas shows the picture. */
    media;
    look;
    source = null;
    stream = null;
    levels = NEUTRAL;
    sampler;
    loop = null;
    shownFrame = -1;
    lastFrame = null;
    rate = 1;
    ended = false;
    mediaClock = false;
    stalled = false;
    cues = [];
    previews = new Map();
    previous = null;
    caption = null;
    constructor(canvas, options = {}) {
        super();
        this.canvas = canvas;
        this.look = {
            cols: options.cols ?? 160,
            glyphs: options.glyphs ?? DEFAULT_GLYPHS,
            boost: options.boost ?? 1.3,
            tint: options.tint ?? null,
            autoLevels: options.autoLevels ?? true,
            background: options.background ?? '#05070a',
            mode: options.mode ?? 'braille',
            edges: options.edges ?? false,
            crt: options.crt ?? false,
            fill: options.fill ?? 0.25,
            sharp: options.sharp ?? true,
            smooth: options.smooth ?? true,
        };
        this.renderer = new GlyphRenderer(canvas, { glyphs: this.look.glyphs, background: this.look.background, ...(options.glyphSize ? { glyphSize: options.glyphSize } : {}), ...(options.font ? { font: options.font } : {}) });
        const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
        if (!context)
            throw new GlyphcastError('Cannot create a 2D context for sampling');
        this.sampler = context;
        this.media = document.createElement('video');
        this.media.playsInline = true;
        this.media.preload = 'auto';
        for (const type of ['play', 'pause', 'volumechange', 'ratechange', 'waiting', 'playing', 'loadedmetadata', 'durationchange', 'progress']) {
            this.media.addEventListener(type, () => {
                if (this.stream && ['durationchange', 'loadedmetadata', 'progress'].includes(type))
                    return;
                this.emit(type);
            });
        }
        this.media.addEventListener('ended', () => {
            if (!this.stream)
                this.finish();
        });
        this.media.addEventListener('seeked', () => this.draw());
        this.media.addEventListener('loadeddata', () => this.draw());
        this.media.addEventListener('error', () => this.fail(new GlyphcastError(this.media.error?.message || 'The media cannot be played')));
    }
    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
    fail(error) {
        this.emit('error', error);
    }
    /** Type of the loaded source, or null. */
    get sourceType() {
        return this.source?.type ?? null;
    }
    /** Current look. */
    get options() {
        return this.look;
    }
    /** Changes the look on the fly: grid width, glyphs, colors, levels. */
    configure(options) {
        const glyphs = options.glyphs !== undefined && options.glyphs !== this.look.glyphs;
        const background = options.background !== undefined && options.background !== this.look.background;
        this.look = { ...this.look, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
        if (glyphs)
            this.renderer.setGlyphs(this.look.glyphs);
        if (background)
            this.renderer.setBackground(this.look.background);
        this.shownFrame = -1;
        this.redraw();
    }
    /**
     * Shows subtitles drawn with glyphs over the picture: WebVTT or SRT text, a URL to fetch it from, or null to
     * hide them. Cues follow `currentTime`, so they stay in sync after seeks and server restarts.
     */
    async setCaptions(captions) {
        if (captions === null)
            this.cues = [];
        else if (captions instanceof URL || !captions.includes('-->')) {
            const response = await fetch(captions);
            if (!response.ok)
                throw new GlyphcastError(`Cannot load subtitles: HTTP ${response.status}`);
            this.cues = parseCaptions(await response.text());
        }
        else
            this.cues = parseCaptions(captions);
        this.caption = null;
        this.renderer.setCaption(null);
        this.redraw();
    }
    /**
     * Matches glyph size to the displayed height in device pixels, so the canvas maps onto screen pixels instead of
     * being scaled, which makes small glyphs shimmer.
     */
    fit(height) {
        const size = Math.min(48, Math.max(6, Math.floor(height / this.grid().rows)));
        if (size === this.renderer.cellHeight)
            return;
        this.renderer.setGlyphSize(size);
        this.shownFrame = -1;
        this.redraw();
    }
    redraw() {
        if (this.lastFrame && this.stream)
            this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
        else
            this.draw();
    }
    /** Grid of the current source. */
    grid() {
        if (this.stream?.reader.info)
            return { cols: this.stream.reader.info.cols, rows: this.stream.reader.info.rows };
        const video = this.media;
        if (this.source?.type === 'video' && this.source.prescaled && video.videoWidth > 0)
            return { cols: video.videoWidth, rows: video.videoHeight };
        const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
        return { cols: this.look.cols, rows: Math.max(1, Math.round(this.look.cols * aspect * 0.6)) };
    }
    /** Loads a source and shows its first frame. Resolves once metadata is known. */
    async load(source) {
        const next = typeof source === 'string' ? sourceFor(source) : source;
        this.unload();
        this.source = next;
        this.ended = false;
        if (next.type === 'video') {
            this.mediaClock = true;
            const video = this.media;
            if (next.src instanceof MediaStream)
                video.srcObject = next.src;
            else
                video.src = typeof next.src === 'string' ? next.src : URL.createObjectURL(next.src);
            if (typeof next.src === 'string' && !next.src.startsWith('blob:') && !next.src.startsWith('data:'))
                video.crossOrigin = 'anonymous';
            await new Promise((resolve, reject) => {
                video.addEventListener('loadeddata', () => resolve(), { once: true });
                video.addEventListener('error', () => reject(new GlyphcastError(video.error?.message || 'The video cannot be loaded')), { once: true });
            });
            this.draw();
            return;
        }
        await this.openStream(next, 0);
    }
    async openStream(source, offset) {
        const urls = offset > 0 && source.restart ? source.restart(offset) : { src: source.src, ...(source.audio ? { audio: source.audio } : {}) };
        const state = { source, reader: new StreamReader(), chunks: [], decoded: new Map(), abort: new AbortController(), offset, url: urls.src, segment: new AbortController(), index: null, done: false, clockStart: 0, clockAt: 0 };
        state.abort.signal.addEventListener('abort', () => state.segment.abort());
        this.stream = state;
        this.stalled = false;
        this.shownFrame = -1;
        this.mediaClock = Boolean(urls.audio);
        if (urls.audio) {
            this.media.src = urls.audio;
            this.media.crossOrigin = 'anonymous';
        }
        else {
            this.media.removeAttribute('src');
        }
        const response = await fetch(urls.src, { signal: state.segment.signal, priority: 'low' });
        if (!response.ok || !response.body)
            throw new GlyphcastError(`Cannot load ${urls.src}: HTTP ${response.status}`);
        await new Promise((resolve, reject) => {
            const sound = [];
            this.download(state, response, state.reader, state.segment, (chunks) => {
                for (const chunk of chunks) {
                    if (chunk.subtitles) {
                        if (!this.cues.length)
                            void this.setCaptions(new TextDecoder().decode(chunk.data));
                    }
                    else if (chunk.frames === 0)
                        sound.push(chunk.data);
                }
                if (sound.length > 0 && state.chunks.length > 0 && !this.mediaClock) {
                    this.media.src = URL.createObjectURL(new Blob(sound, { type: audioType(sound[0] ?? new Uint8Array()) }));
                    this.mediaClock = true;
                }
                if (state.reader.info && state.chunks.length > 0)
                    resolve();
            }).then(() => {
                if (!state.reader.info)
                    throw new GlyphcastError('The stream ended before its header');
                resolve();
            }).catch((error) => {
                if (state.abort.signal.aborted)
                    return;
                reject(error);
                this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
            });
        });
        this.emit('loadedmetadata');
        this.emit('durationchange');
        this.draw();
        if (!state.done && !source.restart && !urls.src.startsWith('blob:'))
            void this.loadIndex(state);
    }
    async download(state, response, reader, segment, onChunks) {
        const body = response.body?.getReader();
        if (!body)
            return;
        for (;;) {
            while (!segment.signal.aborted && this.stream === state && this.bufferedEnd - this.currentTime > AHEAD)
                await new Promise((wait) => setTimeout(wait, 250));
            if (segment.signal.aborted)
                return;
            const { done, value } = await body.read();
            if (done)
                break;
            const chunks = reader.push(value);
            for (const chunk of chunks)
                if (chunk.frames > 0)
                    this.store(state, chunk);
            onChunks?.(chunks);
            if (chunks.length > 0)
                this.emit('progress');
        }
        state.done = true;
        this.emit('progress');
        this.emit('durationchange');
    }
    store(state, chunk) {
        const chunks = state.chunks;
        let at = chunks.length;
        while (at > 0 && (chunks[at - 1]?.start ?? 0) > chunk.start)
            at -= 1;
        if (chunks[at - 1]?.start === chunk.start)
            return;
        chunks.splice(at, 0, chunk);
    }
    async loadIndex(state) {
        try {
            const tail = await fetch(state.url, { headers: { range: `bytes=-${INDEX_TRAILER}` }, signal: state.abort.signal });
            if (tail.status !== 206) {
                await tail.body?.cancel();
                return;
            }
            const length = indexLength(new Uint8Array(await tail.arrayBuffer()));
            if (!length)
                return;
            const chunk = await fetch(state.url, { headers: { range: `bytes=-${length}` }, signal: state.abort.signal });
            if (chunk.status === 206)
                state.index = readIndex(new Uint8Array(await chunk.arrayBuffer()));
        }
        catch {
            state.index = null;
        }
    }
    /**
     * A small picture of the stream at a time, for seek bar previews: the key frame of the chunk there, decoded from
     * memory or fetched with a range request when the file has an index. Null for videos and unreachable places.
     */
    async preview(seconds) {
        const stream = this.stream;
        const info = stream?.reader.info;
        if (!stream || !info)
            return null;
        const frame = Math.max(0, Math.floor((seconds - stream.offset) * info.fps));
        const loaded = stream.chunks.find((chunk) => frame >= chunk.start && frame < chunk.start + chunk.frames);
        if (loaded) {
            const { frames } = await this.decode(stream, info, loaded);
            return frames[0] ? { pixels: frames[0], cols: info.cols, rows: info.rows } : null;
        }
        const entry = stream.index?.find((item) => frame >= item.start && frame < item.start + item.frames);
        if (!entry)
            return null;
        const cached = this.previews.get(entry.start);
        if (cached)
            return cached;
        const head = await fetch(stream.url, { headers: { range: `bytes=${entry.offset}-${entry.offset + 5}` } });
        if (head.status !== 206)
            return null;
        const size = new DataView(await head.arrayBuffer()).getUint32(0, true);
        const body = await fetch(stream.url, { headers: { range: `bytes=${entry.offset + 6}-${entry.offset + 5 + size}` } });
        if (body.status !== 206)
            return null;
        const { frames } = await decodeChunkMotion(info, new Uint8Array(await body.arrayBuffer()));
        if (!frames[0])
            return null;
        const picture = { pixels: frames[0], cols: info.cols, rows: info.rows };
        this.previews.set(entry.start, picture);
        if (this.previews.size > 40)
            this.previews.delete(this.previews.keys().next().value ?? 0);
        return picture;
    }
    async jump(state, frame) {
        const entry = state.index?.find((item) => frame >= item.start && frame < item.start + item.frames);
        const info = state.reader.info;
        if (!entry || !info || state.chunks.some((chunk) => chunk.start === entry.start))
            return;
        state.segment.abort();
        const segment = new AbortController();
        state.segment = segment;
        try {
            const response = await fetch(state.url, { headers: { range: `bytes=${entry.offset}-` }, signal: segment.signal, priority: 'low' });
            if (response.status !== 206) {
                segment.abort();
                return;
            }
            await this.download(state, response, new StreamReader(info, entry.start), segment);
        }
        catch (error) {
            if (!segment.signal.aborted)
                this.fail(error instanceof Error ? error : new GlyphcastError(String(error)));
        }
    }
    regionEnd(stream) {
        const info = stream.reader.info;
        if (!info)
            return 0;
        const frame = Math.max(0, Math.floor((this.currentTime - stream.offset) * info.fps));
        let at = stream.chunks.findIndex((chunk) => frame >= chunk.start && frame < chunk.start + chunk.frames);
        if (at < 0)
            return frame;
        let end = (stream.chunks[at]?.start ?? 0) + (stream.chunks[at]?.frames ?? 0);
        while (stream.chunks[at + 1]?.start === end) {
            at += 1;
            end += stream.chunks[at]?.frames ?? 0;
        }
        return end;
    }
    reachesEnd(stream) {
        const total = stream.reader.info?.frameCount ?? 0;
        return total > 0 ? this.regionEnd(stream) >= total : stream.done;
    }
    unload() {
        this.pauseLoop();
        this.previews.clear();
        this.previous = null;
        this.stalled = false;
        this.mediaClock = false;
        if (this.stream)
            this.stream.abort.abort();
        this.stream = null;
        this.lastFrame = null;
        this.shownFrame = -1;
        const video = this.media;
        video.pause();
        if (video.srcObject instanceof MediaStream)
            for (const track of video.srcObject.getTracks())
                track.stop();
        video.srcObject = null;
        if (video.src.startsWith('blob:'))
            URL.revokeObjectURL(video.src);
        video.removeAttribute('src');
        video.removeAttribute('crossorigin');
        video.load();
    }
    /** Stops playback and releases the source. */
    destroy() {
        this.unload();
        this.source = null;
    }
    /** True when the media element carries the clock: video sources and streams with audio. */
    get hasAudio() {
        return this.mediaClock;
    }
    get paused() {
        if (this.stream && !this.hasAudio)
            return this.loop === null;
        return this.media.paused && !this.stalled;
    }
    get duration() {
        const stream = this.stream;
        if (stream) {
            const info = stream.reader.info;
            if (stream.source.duration)
                return stream.source.duration;
            if (info?.frameCount)
                return info.frameCount / info.fps;
            const frames = stream.chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
            return info ? stream.offset + frames / info.fps : 0;
        }
        return this.media.duration || 0;
    }
    /** End of the downloaded part, in seconds. */
    get bufferedEnd() {
        const stream = this.stream;
        if (stream)
            return stream.reader.info ? stream.offset + this.regionEnd(stream) / stream.reader.info.fps : stream.offset;
        const ranges = this.media.buffered;
        return ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
    }
    get currentTime() {
        const stream = this.stream;
        if (!stream)
            return this.media.currentTime;
        if (this.hasAudio)
            return stream.offset + this.media.currentTime;
        return stream.clockAt + (this.loop !== null && !this.stalled ? ((performance.now() - stream.clockStart) / 1000) * this.rate : 0);
    }
    set currentTime(seconds) {
        void this.seek(seconds);
    }
    get volume() {
        return this.media.volume;
    }
    set volume(value) {
        this.media.volume = Math.min(1, Math.max(0, value));
    }
    get muted() {
        return this.media.muted;
    }
    set muted(value) {
        this.media.muted = value;
    }
    get playbackRate() {
        return this.stream && !this.hasAudio ? this.rate : this.media.playbackRate;
    }
    set playbackRate(value) {
        if (this.stream && !this.hasAudio) {
            this.syncClock();
            this.rate = value;
            this.emit('ratechange');
        }
        else {
            this.media.playbackRate = value;
        }
    }
    syncClock() {
        const stream = this.stream;
        if (!stream)
            return;
        stream.clockAt = this.currentTime;
        stream.clockStart = performance.now();
    }
    async play() {
        if (!this.source)
            return;
        if (this.ended)
            await this.seek(0);
        this.ended = false;
        if (this.hasAudio || !this.stream)
            await this.media.play();
        else {
            this.syncClock();
            this.emit('play');
            this.emit('playing');
        }
        this.startLoop();
    }
    pause() {
        if (this.stream && !this.hasAudio) {
            if (this.loop === null)
                return;
            this.syncClock();
            this.pauseLoop();
            this.emit('pause');
            return;
        }
        this.stalled = false;
        this.media.pause();
        this.pauseLoop();
        this.draw();
    }
    async seek(seconds) {
        const time = Math.max(0, Math.min(seconds, this.duration || seconds));
        const stream = this.stream;
        if (!stream) {
            this.media.currentTime = time;
            return;
        }
        const info = stream.reader.info;
        const loadedTo = this.bufferedEnd;
        if (stream.source.restart && (time < stream.offset || (time > loadedTo + 2 && !stream.done))) {
            const playing = !this.paused;
            this.pauseLoop();
            await this.openStream(stream.source, time);
            if (playing)
                await this.play();
            return;
        }
        if (this.hasAudio)
            this.media.currentTime = time - stream.offset;
        if (info && !stream.source.restart)
            void this.jump(stream, Math.floor((time - stream.offset) * info.fps));
        stream.clockAt = time;
        stream.clockStart = performance.now();
        this.shownFrame = -1;
        if (info)
            this.draw();
        this.emit('timeupdate');
    }
    finish() {
        this.ended = true;
        this.pauseLoop();
        this.emit('ended');
        this.emit('pause');
    }
    startLoop() {
        if (this.loop !== null)
            return;
        let lastUpdate = 0;
        const tick = () => {
            this.draw();
            const now = performance.now();
            if (now - lastUpdate > 250) {
                lastUpdate = now;
                this.emit('timeupdate');
            }
            const stream = this.stream;
            if (stream)
                this.buffer(stream);
            if (stream?.reader.info && this.currentTime >= this.duration - 0.02 && this.reachesEnd(stream)) {
                if (this.hasAudio)
                    this.media.pause();
                this.finish();
                return;
            }
            if (this.loop !== null)
                this.loop = requestAnimationFrame(tick);
        };
        this.loop = requestAnimationFrame(tick);
    }
    buffer(stream) {
        const ahead = this.bufferedEnd - this.currentTime;
        const end = this.reachesEnd(stream);
        if (!this.stalled && !end && ahead < 0.3) {
            // wait with a loader instead of running the clock past the downloaded frames
            stream.clockAt = this.currentTime;
            this.stalled = true;
            if (this.hasAudio)
                this.media.pause();
            this.emit('waiting');
        }
        else if (this.stalled && (end || ahead > 5)) {
            this.stalled = false;
            stream.clockStart = performance.now();
            if (this.hasAudio)
                void this.media.play().catch(() => undefined);
            this.emit('playing');
        }
    }
    pauseLoop() {
        if (this.loop !== null)
            cancelAnimationFrame(this.loop);
        this.loop = null;
    }
    paint(pixels, cols, rows, masks) {
        this.lastFrame = { pixels, cols, rows, masks };
        pixels = this.steady(pixels);
        this.levels = this.look.autoLevels ? ease(this.levels, autoLevels(pixels)) : NEUTRAL;
        const caption = captionAt(this.cues, this.currentTime);
        if (caption !== this.caption) {
            this.caption = caption;
            this.renderer.setCaption(caption);
        }
        const sharp = this.look.sharp;
        this.renderer.draw(sharp ? upscale2x(pixels, cols, rows) : pixels, cols, rows, { detail: sharp ? 2 : 1, levels: this.levels, boost: this.look.boost, tint: this.look.tint, mode: this.look.mode, edges: this.look.edges, crt: this.look.crt, fill: this.look.fill, masks: masks ?? null });
    }
    steady(pixels) {
        const previous = this.previous;
        if (!previous || previous.length !== pixels.length) {
            this.previous = pixels.slice();
            return pixels;
        }
        const out = new Uint8ClampedArray(pixels.length);
        for (let index = 0; index < pixels.length; index += 1) {
            const before = previous[index] ?? 0;
            const delta = (pixels[index] ?? 0) - before;
            out[index] = delta > -24 && delta < 24 ? before + delta / 3 : before + delta;
        }
        this.previous = out;
        return out;
    }
    /** Draws the frame for the current time. */
    draw() {
        const stream = this.stream;
        if (stream) {
            this.drawStream(stream);
            return;
        }
        const video = this.media;
        if (!this.source || video.readyState < 2 || video.videoWidth === 0)
            return;
        const { cols, rows } = this.grid();
        const canvas = this.sampler.canvas;
        if (canvas.width !== cols || canvas.height !== rows) {
            canvas.width = cols;
            canvas.height = rows;
        }
        this.sampler.drawImage(video, 0, 0, cols, rows);
        let pixels;
        try {
            pixels = this.sampler.getImageData(0, 0, cols, rows).data;
        }
        catch {
            this.pauseLoop();
            this.fail(new GlyphcastError('The video is cross-origin without CORS, so its pixels cannot be read'));
            return;
        }
        this.paint(pixels, cols, rows);
    }
    drawStream(stream) {
        const info = stream.reader.info;
        if (!info)
            return;
        const exact = Math.max(0, (this.currentTime - stream.offset) * info.fps);
        const index = Math.floor(exact);
        const between = this.look.smooth ? exact - index : 0;
        const position = stream.chunks.findIndex((chunk) => index >= chunk.start && index < chunk.start + chunk.frames);
        const chunk = stream.chunks[position];
        if (!chunk) {
            if (this.lastFrame)
                this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
            return;
        }
        const nextChunk = stream.chunks[position + 1];
        if (nextChunk)
            this.decode(stream, info, nextChunk);
        if (between > 0.05) {
            const following = index + 1 < chunk.start + chunk.frames ? chunk : nextChunk?.start === index + 1 ? nextChunk : null;
            if (following) {
                void Promise.all([this.decode(stream, info, chunk), this.decode(stream, info, following)]).then(([current, next]) => {
                    if (this.stream !== stream)
                        return;
                    const from = current.frames[index - chunk.start];
                    const to = next.frames[index + 1 - following.start];
                    const motion = next.motion[index + 1 - following.start];
                    if (!from || !to || !motion)
                        return;
                    this.shownFrame = -1;
                    const masks = between < 0.5 ? current.detail?.[index - chunk.start] : next.detail?.[index + 1 - following.start];
                    this.paint(interpolate(from, to, motion, info.cols, info.rows, between), info.cols, info.rows, masks);
                });
                return;
            }
        }
        if (index === this.shownFrame && this.lastFrame) {
            this.paint(this.lastFrame.pixels, this.lastFrame.cols, this.lastFrame.rows, this.lastFrame.masks);
            return;
        }
        void this.decode(stream, info, chunk).then(({ frames, detail }) => {
            if (this.stream !== stream)
                return;
            const frame = frames[index - chunk.start];
            if (!frame)
                return;
            this.shownFrame = index;
            this.paint(frame, info.cols, info.rows, detail?.[index - chunk.start]);
        });
    }
    decode(stream, info, chunk) {
        let pending = stream.decoded.get(chunk.start);
        if (!pending) {
            pending = decodeChunkMotion(info, chunk.data);
            stream.decoded.set(chunk.start, pending);
            for (const key of stream.decoded.keys())
                if (Math.abs(key - chunk.start) > info.chunkFrames * 3)
                    stream.decoded.delete(key);
        }
        return pending;
    }
}
//# sourceMappingURL=player.js.map