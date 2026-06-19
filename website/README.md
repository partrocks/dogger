# Dogger — marketing website

A tiny, self-contained marketing site for [Dogger](https://github.com/partrocks/dogger).

It's plain static HTML + CSS + a sprinkle of vanilla JS. **No build step, no
dependencies, no framework.** The only external request is to Google Fonts for
the Inter / JetBrains Mono typefaces (the page falls back to system fonts if
that fails).

## Structure

```
website/
  index.html              # the whole page
  styles.css              # all styling (dark, on-brand with the app)
  script.js               # copy-to-clipboard buttons (progressive enhancement)
  install.sh              # the `curl … | bash` installer, served at /install.sh
  favicon.svg             # scalable favicon (the Dogger mark)
  favicon.ico             # multi-size .ico for legacy browsers
  favicon-16x16.png       # PNG favicons
  favicon-32x32.png
  apple-touch-icon.png    # 180×180 icon for iOS home screen
  assets/
    logo.svg              # Dogger logo (copy, so this folder is portable)
    screenshots/*.png     # product screenshots
  README.md               # this file
```

This folder is intentionally isolated from the rest of the repo — it has its
own copy of the logo and screenshots, so you can move or deploy it on its own.

## Develop / preview

Just open `index.html` in a browser, or serve the folder with anything static:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then visit http://localhost:8080.

## Deploy

Upload the contents of this folder to any static host (GitHub Pages, Netlify,
Cloudflare Pages, S3, etc.). The canonical domain is set to `doggerapp.com` in
`index.html` (`<link rel="canonical">` and the Open Graph tags) — update those
if the domain changes.

The install-script command on the page (`curl -fsSL https://doggerapp.com/install.sh | bash`)
is served by `install.sh`, which lives **here** in this folder. As long as you
deploy this folder at the canonical domain, `/install.sh` resolves correctly.

## Editing content

- **Features / install steps / contact** live directly in `index.html`.
- **Brand colours** are CSS variables at the top of `styles.css`
  (`--bg`, `--accent`, `--green`, …) matching the desktop app.
- To swap a screenshot, drop a new PNG into `assets/screenshots/` and update the
  matching `<img src>` in `index.html`.
- **Favicons** are generated from `favicon.svg`. To regenerate the raster
  fallbacks after editing the SVG (macOS, needs Python + Pillow):

```bash
qlmanage -t -s 512 -o /tmp/fav favicon.svg
python3 - <<'PY'
from PIL import Image
src = Image.open("/tmp/fav/favicon.svg.png").convert("RGBA")
src.resize((180,180), Image.LANCZOS).save("apple-touch-icon.png")
src.resize((32,32), Image.LANCZOS).save("favicon-32x32.png")
src.resize((16,16), Image.LANCZOS).save("favicon-16x16.png")
src.resize((256,256), Image.LANCZOS).save(
    "favicon.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY
```
