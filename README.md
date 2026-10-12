# gcast hub

Videos as colored glyphs: watch them in the browser at [mrprolopstar.github.io/gcast-hub](https://mrprolopstar.github.io/gcast-hub/) or in a terminal:

```sh
npx glyphcast hub                 # list and search
npx glyphcast play hub:<name>     # watch, with sound, pause and seeking
```

Openly licensed videos are listed and searchable. Others are reachable only by their link; the file is still public to anyone who has it.

## How it works

- `.gcast` files and posters are assets of the `videos` release of this repository.
- `videos.json` is the catalog of listed videos, `hub.json` points to the file server.
- `worker/` is a Cloudflare Worker: it serves the release assets with CORS and range requests, so players can seek, and accepts uploads with the hub key, then updates the catalog.

## Deploy

```sh
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # fine-grained token: this repo, Contents read and write
npx wrangler secret put HUB_KEY        # any long random string; uploads need it
npx wrangler deploy
```

Put the Worker URL into `hub.json` and enable GitHub Pages for the main branch.
