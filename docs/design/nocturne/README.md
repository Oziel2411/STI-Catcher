# Handoff: STI-Catcher — varios links, varios archivos, elegir pantalla (estilo Nocturne)

## Overview
Three changes to `STI-Catcher` (`apps/web`, `apps/server`, `packages/shared`):

1. **Descargar varios links:** paste many URLs at once; each becomes a row with its **own output format** (MP4/MP3/M4A directly, or WebM/MOV/MKV/AVI/WAV/GIF via an automatic follow-up conversion). Mockup **2a**.
2. **Convertir varios archivos:** drop several files (or add from Historial); a list on the left, a detail panel on the right to pick each file's format. Mockup **2e**.
3. **Grabar pantalla — elegir pantalla o ventana:** choose source type (pantalla / ventana / pestaña) first, see a **live preview** of what the browser shared, change it, *then* start recording. Mockup **2g**.

Plus a new **app shell**: left **side bar** (from 2b/2e/2h) replacing the top bar, and a restyle to the Nocturne look (Inter, outlined primary buttons, tonal tags). **Both light and dark mode stay** (`prefers-color-scheme`), see `tokens.css`.

Chosen combination: shell = side bar · Descargar = 2a · Convertir = 2e · Grabar = 2g. Note that 2a and 2g are drawn with the top bar in the mockup: **render them inside the side-bar shell** instead.

## About the design files
`STI-Catcher Mockups.dc.html` is a **design reference built in HTML**, not production code. Open it in a browser (it needs the sibling `support.js` from the design project; if it won't open, read the markup, since all styles are inline). Recreate the designs in the existing React + Vite app following the repo's conventions (`CLAUDE.md`): plain CSS classes in `apps/web/src/styles.css`, no UI library, Spanish UI copy, English identifiers. Section 1 (1a–1c) of the file is the **current** UI, kept for comparison.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii and copy are final for dark mode. Light mode uses the mapped tokens in `tokens.css` (same structure, light ramp values).

---

## Design tokens
Drop `tokens.css` in place of the `:root` + dark `@media` block at the top of `styles.css`. It keeps every existing variable name, so current pages keep working, and adds `--surface-2`, `--faint`, `--divider`, `--accent-strong`, `--accent-tint`, `--rec`, `--radius-sm`, `--radius-lg`, `--shadow-sm`, `--sidebar-w`.

- Font: **Inter** 400/500 (headings 500, **never bolder**). Base 15px. Mono stays Cascadia Mono / Consolas.
- Type scale used: h1 24px/1.12 −0.015em · card title 15–17px/500 · body 13.5px · table/list 13px · meta 11.5px · kicker 10–11px uppercase +0.08–0.1em.
- Radii: 4 (thumbs in tables, mic meter) · 8 (inputs, buttons, cards, nav items) · 14 (recording preview in 2h, dialogs) · 99px (progress bars).
- Spacing is compact: page padding 24×26px; section gap 16px; card padding 12px (list cards) / 16×18px (detail card); table cell padding 5.6px.
- `nocturne-reference.css` is the full Nocturne system stylesheet, for reference only (exact `.btn`, `.seg`, `.table`, `.tag`, `.input` rules).

## Global component changes (styles.css)
- **`.button` (primary):** outlined, not filled: `color: var(--accent); background: transparent; border: 1px solid var(--accent); padding: 5.6px 10px; border-radius: 8px; font-weight: 500; font-size: 14px;`. Hover `background: color-mix(in srgb, var(--accent) 12%, transparent)`, active 22%. Disabled opacity .45.
- **`.button-secondary`:** `border: 1px solid var(--divider); color: var(--text)`, hover 7% text tint.
- **`.button-danger`:** outline in `--rec`, text `--error` (see "Detener grabación" in 2h).
- **New `.button-ghost`:** no border, accent text, `padding-inline: 3px`; and `.button-icon` 28–30px square.
- **`.badge` → tag style:** `border-radius: 6px; font-size: 11px; padding: 3px 10px;`. Neutral: `--surface-2` bg + `--text`. Ok: `--ok-bg`/`--ok`. Error: `--error-bg`/`--error`. Labels from `STATUS_LABELS`; add "Listo para descargar", "Listo", "Subiendo".
- **`.meter`:** height 4px (5px in cards), no border, track `--surface-2`, fill `--accent` (upload phase fill uses `--muted`). Indeterminate animation unchanged.
- **New `.seg` / `.seg-opt`:** segmented radio group, exactly as Nocturne's (`nocturne-reference.css`): 1px `--divider` border, radius 8, options 7×12px 13px; checked = accent text + `inset 0 0 0 1px var(--accent)`.
- **New `.choice-card`:** selectable option tile, 8×10px padding, radius 8, `box-shadow: 0 0 0 1px var(--divider)`. Selected: `box-shadow: 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent)`, title in `--accent-strong`. Used for presets (2e) and recording source (2g).
- **`.table`:** header cells 11px uppercase +0.08em `--muted`; row rule is a 1px gradient that fades out over 48px at each end (`linear-gradient(to right, transparent, var(--divider) 48px, var(--divider) calc(100% - 48px), transparent)` on the `<tr>` background, bottom, 100%×1px). Row hover 4% text tint.
- Focus everywhere: `outline: 2px solid var(--accent); outline-offset: 2px`. Checkboxes: `accent-color: var(--accent)`.
- Icons: **Phosphor** (`@phosphor-icons/react`, regular weight, 16px in nav, 20px source tiles). Names used: `DownloadSimple, Record, ArrowsLeftRight, ClockCounterClockwise, Pulse, MagnifyingGlass, X, FilmStrip, Warning, Check, Plus, UploadSimple, Files, ArrowDown, Tray, Monitor, AppWindow, Browser, Swap, Microphone, SpeakerHigh, Stop (fill), PlayCircle (fill)`.

## Screens

### Shell: side bar (`components/Layout.tsx`)
- Layout: `display:flex; min-height:100vh`. Aside `width: var(--sidebar-w)` (196px), `padding: 16px 12px`, column, gap 3px, `background: linear-gradient(180deg, var(--surface), var(--bg))`, right edge `box-shadow: inset -1px 0 0 var(--divider)`. Main: `flex:1; min-width:0; padding: 24px 26px 28px; max-width: 1080px`.
- Brand: logo 28×28 radius 6 + "STI-Catcher" 15px/500, padding `0 6px 16px`. Keep the existing `alt` text.
- Nav items (same `NAV_ITEMS` + icon): `NavLink` row, gap 9px, padding 7×9px, radius 8, 13.5px, color `--muted`. **Active:** bg `--accent-tint`, text `--accent-strong`, icon `--accent`. Hover: 7% text tint.
- Right-aligned counter on an item (`margin-left:auto; font-size:11px; color:var(--accent)`): number of **active jobs of that type started from this browser** (Descargar 3, Convertir 2). While recording, Grabar pantalla shows a 7px pulsing `--rec` dot instead.
- The footer text "Usar solo con contenido propio o con autorización." moves to the bottom of the side bar (`margin-top:auto`, 11px, `--faint`).
- **Responsive (<760px):** collapse the aside into a top bar (the 2a header: brand + horizontal nav, wrap) so phones keep working.

### Descargar (2a) — `features/download/DownloadPage.tsx`
Header: h1 "Descargar videos"; sub "YouTube, Instagram, X y otros sitios. Pegá uno o varios links, uno por línea."

1. **Input card** (`.card`, row, align end, gap 12, padding 12): field "Links" = `<textarea>` min-height 62px, mono 12.5px/1.6. Button "Analizar N links" (MagnifyingGlass icon), where N = number of valid lines not already in the list. Disabled when N=0 (label "Analizar").
   - Parsing: split on newlines/whitespace, trim, dedupe against the list, validate with the existing `httpUrlSchema`. Invalid lines are not added; show an error alert listing them as `renglón 3 · «texto»` (see 2c). On submit, clear the textarea of accepted lines.
2. **Toolbar** (row, gap 12, 13px): "7 links" (muted) · 1×16px divider · "Formato para los seleccionados" + compact select (30px tall) + secondary "Aplicar a N" · right-aligned primary "Descargar N listos" (DownloadSimple), N = rows in `ready` state that are checked (or all ready if none checked; pick one rule and keep it).
3. **Table** columns: checkbox 28px · Video (thumb 64×36 radius 4 `--surface-2` with FilmStrip placeholder when no `thumbnailUrl`; title ellipsis max 300px; meta 11.5px `site · uploader · duración`) · Formato 170px · Calidad 150px · Estado 250px · actions 70px right-aligned.
   Row states (all visible in 2a):
   - `analyzing`: skeleton title, Estado "Analizando…".
   - `ready`: Formato and Calidad are selects; Estado tag "Listo para descargar"; action X (remove). Checkbox enabled.
   - `queued`: selects become plain text (75% text), tag "En cola", action "Quitar" (= cancel).
   - `running`: meter + line `PHASE_LABELS · % · velocidad · faltan …` (reuse `JobProgress` detail logic), action "Cancelar" in `--error`.
   - `converting` (chained follow-up): indeterminate or % meter, text "Descargado · Convirtiendo a GIF".
   - `done`: tag "Terminado" + size; action icon button DownloadSimple → `/api/jobs/:id/file` (the final file: the conversion's if there was one).
   - `failed` (probe or job): thumb becomes a red tint tile with Warning; URL in mono; message in `--error` under it; tag "Falló"; action "Reintentar" (re-probe, or `POST /api/jobs/:id/retry` if a job exists).
   - Live streams: warning alert (2c) and the row cannot be started.
   - **Formato select** (grouped `<optgroup>`): *Video* MP4, WebM, MOV, MKV, AVI · *Animación* GIF · *Solo audio* MP3, M4A, WAV. Disable video/audio options using `hasVideo`/`hasAudio`. **Calidad select**: for MP4, the existing resolutions (`resolutionLabel`) plus codec mode via an inline "Compatibilidad máxima / Máxima calidad / Recodificar" second select or popover; for other video presets, "Mantener / Reducir a Np" (`scaleOptions`); for GIF, `ancho px · fps` (reuse `defaultGif`); for audio, "—". Show `codecNotices` for a row as a warn line under the row (expandable), not as page alerts.
4. **Empty state** (2c): no rows → under the input, Tray icon 26px `--faint`, "Todavía no agregaste links." + "Los que pegues aparecen acá para elegir el formato de cada uno."
- Persist the list (URLs + chosen format + jobIds) in `sessionStorage` so a reload keeps the batch; jobs keep updating through `/api/events` SSE (`applyEventToList` pattern).

### Convertir (2e) — `features/convert/ConvertPage.tsx`
Header row: h1 "Convertir archivos" + sub "Elegí un archivo de la lista para cambiar su formato de salida."; right: secondary "Agregar archivos" (Plus) and primary "Convertir N" (ArrowsLeftRight), N = items in `ready`.
- **Empty / drag states (2f):** a dashed dropzone (1.5px dashed `--divider`, radius 8, 30×16 padding, left-aligned): Files icon, "Arrastrá uno o varios archivos acá", "O elegí del historial. Máximo {maxUploadBytes}.", primary "Elegir archivos" (`<input type=file multiple>`). Dragging: border `--accent`, soft radial accent glow top-left, ArrowDown, "Soltá para agregar N archivos"; a file over the limit shows a warn line and is skipped.
- **Grid:** `grid-template-columns: 330px minmax(0,1fr); gap: 16px; align-items:start`.
- **Left list** (gap 6): item = 10×12 padding, radius 8. Line 1: filename (13.5px, ellipsis) + right tag with chosen format (`tag-accent` style: `--accent-tint` bg / `--accent-strong` text, e.g. "MP4 · 720p", "GIF", "MP3"). Line 2 meta 11.5px muted: `duración · tamaño · estado`. Selected item: `--surface` bg + 1px `--accent` ring. States: uploading/converting add a 4px meter + text; done = tag "Terminado" + "Descargar" link; failed = 8% error tint bg, tag "Falló", message in `--error`.
- **Right detail card** (`.card`, 16×18 padding, gap 12): title (filename, 17px/500) + meta (`TYPE_LABELS · duración · WxH · codecs · tamaño`, same as today's `sourceDetails`). Then 3 columns (`repeat(3,minmax(0,1fr))`, gap 14) = `PRESET_GROUPS` (Video / Animación / Solo audio), each a kicker label + `.choice-card`s with `CONVERSION_PRESETS[id].label` (13.5px) and `.description` (11.5px muted). Show the 3 main video presets and fold the rest into "+ MKV, AVI" / "+ WAV" (click expands). Hide unavailable presets (from `source.presets`), and keep today's "no tiene video/audio" warnings.
  - Below: "Resolución" + `.seg` (Mantener (Np) / 720p / 480p / 360p from `scaleOptions`), only for scalable presets. GIF selected → replace with the existing GIF fields (Inicio, Fin, Cuadros por segundo, Ancho + duración line + `gifProblems`), laid out in one row like 2d.
  - Right-aligned ghost button "Usar este formato en todos" applies preset + resolution to every `ready` item.
- Items from Historial: keep `?origen=<jobId>` support, but allow several (`?origen=a,b,c`) and add them to the list.

### Grabar pantalla (2g) — `features/recording/RecordingPage.tsx`
Header unchanged copy. Grid `minmax(0,1fr) 320px`, gap 16.
- **Left column:**
  1. Three source tiles in a row (`.choice-card`, icon 20px + title 13.5px + hint 11.5px): **Pantalla completa** "Todo lo que se ve" (Monitor) · **Ventana** "Un solo programa" (AppWindow) · **Pestaña** "Con su sonido" (Browser). Selected = accent ring/tint, icon `--accent`. Default: Pantalla completa.
  2. Preview area 16:9, radius 8, `linear-gradient(160deg, var(--surface-2), var(--bg))`, `--shadow-sm`. Before choosing: centered icon + "Elegí qué compartir" + primary "Elegir pantalla…". After choosing: a `<video autoplay muted playsinline>` with `srcObject = displayStream`, plus a bottom overlay bar (10px inset, radius 8, bg `color-mix(--bg 85%)`): icon of the actual surface, label `Ventana · {track.label}`, meta `{width}x{height} · con/sin sonido`, secondary "Cambiar" (Swap).
  3. Muted help line: "«Cambiar» vuelve a abrir el selector del navegador en la solapa del tipo elegido. Todavía no se está grabando."
- **Right card** (padding 14, gap 12): Título (optional) input · "Cuadros por segundo" `.seg` full width "30 · documentos" / "60 · movimiento" · checkbox "Sonido del sistema o de la pestaña" + hint · checkbox "Micrófono" · when mic is on, a live level meter (Microphone icon + 4px bar, `AnalyserNode` RMS) · primary block button 40px "Empezar a grabar" with a 10px `--rec` dot. Disabled until a source is chosen.
- **Recording:** keep today's status line (`recording-dot`, "Grabando mm:ss", subidos, reintentando…) under the preview; the preview gets a 1px `--rec` ring; the button becomes "Detener grabación" (danger outline, Stop fill icon). Options are disabled.
- **Done / errors (2i):** keep `RecordingDone` (player + "Descargar MP4", "Convertir", "Ver en el historial"), restyled. Existing error/warn messages are unchanged (as alerts with `--error-bg` / `--warn-bg`, radius 8, 10×12 padding, 13px).

#### How the source picker works (important)
A web page **cannot list open windows/screens**; the browser's own dialog always does the picking. The design sets that dialog up and adds a preview step:
```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { displaySurface: kind /* 'monitor' | 'window' | 'browser' */, frameRate: { ideal: fps } },
  audio: systemAudio,
  selfBrowserSurface: 'exclude',   // don't offer STI-Catcher's own tab
  surfaceSwitching: 'include',     // Chrome: "Compartir esta pestaña" switcher
  systemAudio: 'include',
  monitorTypeSurfaces: 'include',
});
const track = stream.getVideoTracks()[0];
const { displaySurface, width, height } = track.getSettings(); // actual choice
const label = track.label;          // e.g. window title (Chrome/Edge)
```
- `displaySurface` is a **hint**: Chrome/Edge open the dialog on that tab; Firefox ignores it. Always show what was *actually* picked (from `getSettings()`), and if it differs from the tile, select that tile.
- Split today's `start()` into **`chooseSource()`** (getDisplayMedia → phase `previewing`, keeps the stream) and **`startRecording()`** (mic, mixing, `createRecording`, `MediaRecorder` on the existing stream). "Cambiar" stops the old tracks and calls `chooseSource()` again. Leaving the page or the `ended` event on the track during `previewing` → back to `idle`.
- New phase union: `idle | choosing | previewing{stream} | starting | recording | finishing | tracking`.
- Show the system-audio warning as soon as the preview stream has no audio track (before recording, not after).

---

## API changes
Follow repo rules: Zod schemas in `packages/shared`, `parseInput`, jobs return `202 { jobId }`, new migrations appended.

1. **Download + follow-up conversion** (needed for WebM/MOV/MKV/AVI/WAV/GIF in Descargar):
   - `downloadRequestSchema` gets optional `then: { preset: ConversionPresetId, maxHeight: number|null, gif?: GifOptions } | null` (default null).
   - Server: when that download job finishes `done`, enqueue a conversion job with `sourceJobId = download.id` and the given options (same code path as `POST /api/jobs/convert`). Store the link: migration adds `jobs.next_job_id` (or `parent_job_id` on the conversion, which already exists as `parentTitle` in history, so reuse it). Expose `followUpJobId` on `Job` so the row can follow the second job over SSE.
   - Download format for the first step: MP4 compat for video presets, M4A for audio presets (best source for MP3/WAV), MP4 for GIF.
   - If the download is cancelled or fails, no follow-up is created. Cancelling a row with a running follow-up cancels the follow-up.
2. **Probing many links:** no new endpoint required. The client calls `POST /api/media/probe` per URL with **concurrency 3**. Optional: `POST /api/media/probe-batch { urls: string[] (max 20) }` → `{ results: ({ ok: true, probe } | { ok: false, url, message })[] }` if you want one request.
3. **Creating many jobs:** loop over `POST /api/jobs/download` / `POST /api/jobs/convert`; the server queue already limits concurrency. Uploads: send files **one at a time** through the existing `uploadFile` (keeps the `maxUploadBytes` check per file).
4. `GET /api/conversion/sources/:id` is called per file once its upload finishes, to know its available presets.
5. No changes are needed for recording on the server.

## State management (web)
- `useBatch<Item>()` hook shared by Descargar and Convertir: `items: Item[]`, `add`, `remove`, `update(id, patch)`, `selected: Set<id>`, `applyFormatToSelected`, `startReady()`. Item: `{ id (client uuid), source: {url}|{file}|{historyJobId}, probe|source, status: 'analyzing'|'uploading'|'ready'|'failed'|'job', format, options, jobId?, followUpJobId?, error? }`. When status is `job`, render from the live `Job` (subscribe once to `/api/events`, apply with `applyJobEvent`).
- Persist to `sessionStorage` (`sti.download.batch`, `sti.convert.batch`) without `File` objects (only uploaded ids).
- Recording: phase union above + `sourceKind`, `previewStream`, `micLevel`.

## Copy (Spanish, final)
All strings in the mockup are final. Existing strings from the current components (preset labels/descriptions, codec notices, recording errors, `STATUS_LABELS`, `PHASE_LABELS`) stay as they are.

## Assets
- `assets/logo-128.png`: the existing `apps/web/public/logo-128.png` (unchanged).
- Icons: Phosphor (add `@phosphor-icons/react`).
- Thumbnails: the `probe.thumbnailUrl` with `referrerPolicy="no-referrer"` (as today); the FilmStrip tile is only the fallback.

## Files in this bundle
- `STI-Catcher Mockups.dc.html`: all mockups. Section 2 has the redesign (chosen: **2a**, **2e**, **2g**, side bar from **2b/2e/2h**; states in **2c**, **2f**, **2i**). Section 1 is the current UI.
- `tokens.css`: drop-in token block for light + dark.
- `nocturne-reference.css`: Nocturne system stylesheet (reference).
- `assets/logo-128.png`.

## Suggested order (one phase at a time, `npm run check` + commit each)
1. Tokens + shell (side bar) + global component restyle.
2. Recording source picker + preview (web only).
3. Convertir with multiple files (web only).
4. Download follow-up conversion (shared + server + migration + tests).
5. Descargar with multiple links (web).
