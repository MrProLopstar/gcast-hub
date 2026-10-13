# gcast hub

Videos as colored glyphs: watch them at [glc-hub.1lop.ru](https://glc-hub.1lop.ru) or in a terminal:

```
npx glyphcast hub                    # list and search
npx glyphcast play hub:<name>        # watch, with sound, pause and seeking
```

## How it works

- `app/` is the site: React + Vite, built into `docs/`, which GitHub Pages serves on glc-hub.1lop.ru (`cd app && npm run build`).
- `worker/` is a Cloudflare Worker: files live in a private Google Drive folder, the worker serves them in cached 4 MB blocks with range requests, keeps the catalog, views and votes in a Durable Object, and checks every upload is a real `.gcast`.
- Anyone can upload; openly licensed videos reach the open list after review in `admin.html`.

## Deploy the worker

```
cd worker
node google-login.mjs <client_secret.json>   # connects Google Drive, stores the keys as worker secrets
npx wrangler secret put HUB_KEY              # admin key
npx wrangler deploy
```
