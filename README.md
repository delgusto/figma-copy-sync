# Copy Sync

A Figma plugin that exports UI copy from your Figma file into a downloadable bundle: machine-readable JSON, a stakeholder XLSX, an HTML table you can paste into Confluence, and one PNG screenshot per frame that uses each piece of copy.

Source of truth is **Figma string variables**. Writers and designers edit copy directly in the Figma variables panel. The plugin produces an export bundle on demand — no backend, no syncing service, no auth.

**Two-way sync**: export the XLSX, edit copy in Excel or Google Sheets, re-import the XLSX. Changes write directly back to Figma variables.

---

## What's in the export bundle

```
copy-sync-<file>-<timestamp>.zip
├─ strings.json     ← devs consume this
├─ strings.xlsx     ← stakeholders open this in Excel
├─ strings.html     ← paste into a Confluence page
└─ frames/
   ├─ Payment.png
   ├─ Cart.png
   └─ ...           ← one PNG per frame that uses a tracked variable
```

---

## Setup

Prereqs: Node 20+, Figma desktop app, Figma plan that supports **string variables** (Professional or Organization).

```bash
npm install
npm run build
```

---

## Load + run

1. In Figma desktop: `Plugins` → `Development` → `Import plugin from manifest…`
2. Pick `figma-plugin/manifest.json`.
3. Open the file you want to export.
4. Run `Plugins` → `Development` → `Copy Sync`.

The plugin panel lists every variable collection in the file that contains string variables.

---

## Exporting

1. Tick the collections that hold UX copy (any collection named `Copy*` is pre-selected automatically).
2. Optionally toggle **Highlight copy on screenshots** to draw red outlines around each variable's text in the frame PNGs.
3. Click **Export bundle** → save the ZIP.

---

## Importing (two-way sync)

After exporting and editing the XLSX:

1. Click **Import XLSX…** in the plugin footer.
2. Pick your edited `strings.xlsx` (must be a Copy Sync export — the `id` column is required).
3. Review the preview: variable names and new mode values are listed.
4. Click **Apply N changes**.
5. The results panel shows which variables updated, which weren't found in this file, and any mode warnings.

Only the mode-value columns are written back. All other columns (`id`, `name`, `group`, `collection`, `description`, `frames`, `screenshot_files`) are ignored on import — they're read-only context.

> **Which XLSX to import?** The exported `strings.xlsx` is the import template — no separate template needed. Edit mode-value columns only; don't touch the `id` column.

---

## What goes in each column (XLSX / JSON)

- **collection** — the Figma variable collection's name.
- **group** — everything before the last `/` in the variable name. E.g. `page 1/heading` → group is `page 1`. Lets you organise hundreds of strings under sub-paths inside a single collection.
- **name** — the leaf segment (`heading`).
- **id** — full slash-path (`page 1/heading`). Stable as long as the path doesn't change. **Don't edit this column** — it's used to match rows back to Figma variables on import.
- **description** — comes from the **variable's description in Figma** (variables panel → Edit variable → Description). Use for context, character-limit notes, etc. Empty = no description set.
- **one column per mode** — every Figma variable mode in the selected collections becomes its own column. English-only files typically have one mode; multi-locale files (modes `en`, `es`, `fr`) get one column per locale automatically.
- **frames** — comma-separated list of top-level frame names where the variable is used.
- **screenshot_files** — filenames inside the bundle's `frames/` folder.

> The plugin auto-refreshes when you edit variables in Figma. There's also a **Refresh** button to force a re-scan.

---

## How it picks "copy" variables

Not every Figma string variable is UI copy (some hold URLs, brand names, design-token labels). Three layered filters:

1. **Convention (auto)**. Any variable collection whose name starts with `Copy` (case-insensitive) is preselected. Examples: `Copy`, `Copy / Checkout`, `Copy — onboarding`.
2. **Manual override**. Tick or untick any collection in the plugin UI. Selection persists on the file via `figma.root` plugin data — next time you open the plugin in this file, your last selection is remembered.
3. **Per-variable opt-out**. Variables whose description starts with `[skip]` are excluded even if their collection is selected. Useful for one-off internal-only strings inside an otherwise-copy collection.

---

## How `strings.html` is laid out

The HTML table is **frame-centric**: rows are grouped by top-level Figma frame, not by variable.

**Columns:** Frame | Screenshot | Variable | Description | [one column per mode]

- First row of each frame group: frame name + screenshot + first variable.
- Subsequent rows in the group: empty frame/screenshot cells + next variable.
- No rowspan — Confluence-safe.
- Variables that appear in multiple frames show up in each relevant group.
- Variables not bound to any text layer appear in a `— (no frame)` group at the bottom.

---

## Demo flow

1. Create a variable collection named `Copy` (or `Copy / Checkout`, etc.).
2. Add a few `String` variables to it (e.g. `checkout/payment/cta-primary` = `Pay now`).
3. On the canvas, create a text layer. Right-click the text → `Apply variable` → pick one of your copy variables. Repeat in different frames.
4. Run the plugin → click **Export bundle**.
5. Save the downloaded ZIP. Unzip it.

You should see:
- `strings.json` — every selected variable, its value per mode, and which frames use it.
- `strings.xlsx` — same data as a spreadsheet, with a `_meta` sheet for traceability.
- `strings.html` — a frame-grouped table with embedded screenshots.
- `frames/*.png` — one screenshot per frame containing at least one tracked variable.

---

## Pasting into Confluence

1. Open `strings.html` in a browser.
2. Select all (`⌘A` / `Ctrl+A`), copy.
3. In Confluence (edit mode), paste. The table renders with inline styles + **embedded screenshots** preserved.

Screenshots are embedded as `data:image/png;base64,…` inline in the HTML, so a single paste carries the images — no manual attach step. The `frames/*.png` files in the ZIP are still there for use elsewhere (XLSX references them by filename).

> **Trade-off:** embedding inflates the HTML by ~33% per image. A bundle with 50 high-res frames produces HTML around 10–15 MB. Confluence Cloud handles this fine; Confluence Server may rate-limit large pastes. If you hit issues, fall back to filename references — open an issue and we'll add a toggle.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | One-shot build to `figma-plugin/dist/`. |
| `npm run watch` / `npm run dev` | Rebuild on file change. Reload plugin in Figma after each change. |
| `npm run typecheck` | TypeScript noEmit check. |

---

## Repo layout

```
copy-sync/
├─ figma-plugin/
│  ├─ manifest.json
│  ├─ tsconfig.json
│  ├─ build.mjs
│  └─ src/
│     ├─ main.ts                 ← plugin sandbox: reads vars + frames, exports PNGs, handles import
│     ├─ ui.tsx                  ← React panel: collection picker, export + import UI
│     ├─ ui.html                 ← UI shell
│     ├─ types.ts                ← shared types
│     ├─ annotate.ts             ← canvas-based PNG annotation (red highlight boxes)
│     ├─ zip.ts                  ← bundle + browser download (jszip)
│     └─ exporters/
│        ├─ json.ts              ← strings.json
│        ├─ xlsx.ts              ← strings.xlsx (SheetJS)
│        └─ html.ts              ← strings.html (frame-centric, Confluence-paste-friendly)
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## Troubleshooting

- **"No string variables found"** → Add at least one `String` variable to a collection in your file, or untick collections you've excluded.
- **Plugin won't load** → Make sure you imported `figma-plugin/manifest.json` and your dist build is fresh (`npm run build`).
- **Empty `frames/` folder** → Selected variables aren't bound to any text layers. Right-click a text layer → `Apply variable`.
- **Bundle too large (>50MB)** → Many high-res frames. A 1× screenshot toggle is on the roadmap.
- **Import: "Missing id column"** → You're importing a file that isn't a Copy Sync export. Use the `strings.xlsx` from an export bundle.
- **Import: variables not found** → The XLSX was exported from a different Figma file. Variable names must match exactly.
