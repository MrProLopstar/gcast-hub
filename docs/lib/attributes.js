const NAMES = {
    src: 'src',
    audio: 'audio',
    poster: 'poster',
    subtitles: 'subtitles',
    youtube: 'youtube',
    file: 'file',
    server: 'server',
    cols: 'cols',
    glyphs: 'glyphs',
    tint: 'tint',
    boost: 'boost',
    fill: 'fill',
    autoLevels: 'autolevels',
    mode: 'mode',
    edges: 'edges',
    crt: 'crt',
    autoPlay: 'autoplay',
    muted: 'muted',
    loop: 'loop',
};
export const PLAYER_EVENTS = ['play', 'pause', 'ended', 'timeupdate', 'error'];
export const attributesOf = (props) => {
    const out = {};
    for (const [key, name] of Object.entries(NAMES)) {
        const value = props[key];
        if (value === undefined || value === false)
            continue;
        out[name] = key === 'autoLevels' ? String(value) : value === true ? '' : String(value);
    }
    if (props.autoLevels === false)
        out['autolevels'] = 'false';
    return out;
};
//# sourceMappingURL=attributes.js.map