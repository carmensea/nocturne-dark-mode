# Test fixtures

Serve this directory and open each page with the extension installed:

```bash
python3 -m http.server 8765
```

| Page | Expected mode | What it covers |
| --- | --- | --- |
| `index.html` | `generic` | Cards, tables, forms, gradients, brand colours, inline styles (plain and `!important`), SVG presentation attributes, a photo and emoji |
| `native-dark.html` | `site-theme` | A site shipping its own `prefers-color-scheme: dark` theme |
| `already-dark.html` | `passthrough` | A site that is already dark and should be left alone |
| `declared-dark.html` | `passthrough` | A light page that switches to its own dark theme via `data-theme="dark"` after load, with dark SVG panels |
| `dynamic.html` | `generic` | Shadow DOM, an iframe, content and stylesheets injected after load, 3 000 inline-styled nodes |
| `flash.html` + `black.html` | — | Navigate from `black.html` to `flash.html` with the network throttled to watch for a white frame |

The popup's status line reports which mode the engine chose.
