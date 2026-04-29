# Copy Sync

A Figma plugin that exports UI copy from your Figma file into a downloadable bundle: machine-readable JSON, a stakeholder XLSX, an HTML table you can paste into Confluence, and one PNG screenshot per frame that uses each piece of copy.

Source of truth is **Figma string variables**. Writers and designers edit copy directly in the Figma variables panel. The plugin produces an export bundle on demand — no backend, no syncing service, no auth.

> See [the plan](/Users/davidgustafson/.claude/plans/i-want-to-build-keen-comet.md) for context on why this approach replaced the original Excel-on-SharePoint design.

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

Prereqs: Node 18+, Figma desktop app, Figma plan that supports **string variables** (Professional or Organization).

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

## How it picks "copy" variables

Not every Figma string variable is UI copy (some hold URLs, brand names, design-token labels). Three layered filters:

1. **Convention (auto)**. Any variable collection whose name starts with `Copy` (case-insensitive) is preselected. Examples: `Copy`, `Copy / Checkout`, `Copy — onboarding`.
2. **Manual override**. Tick or untick any collection in the plugin UI. Selection persists on the file via `figma.root` plugin data — next time you open the plugin in this file, your last selection is remembered.
3. **Per-variable opt-out**. Variables whose description starts with `[skip]` are excluded even if their collection is selected. Useful for one-off internal-only strings inside an otherwise-copy collection.

---

## Demo flow

1. Create a variable collection named `Copy` (or `Copy / Checkout`, etc.).
2. Add a few `String` variables to it (e.g. `checkout/payment/cta-primary` = `Pay now`).
3. On the canvas, create a text layer. Right-click the text → `Apply variable` → pick one of your copy variables. Repeat in different frames.
4. Run the plugin → click **Export bundle**.
5. Save the downloaded ZIP. Unzip it.

You should see:
- `strings.json` — every selected variable, its value, and which frames use it.
- `strings.xlsx` — same data as a spreadsheet, with a `_meta` sheet for traceability.
- `strings.html` — a styled table.
- `frames/*.png` — one screenshot per frame containing at least one tracked variable.

---

## Pasting into Confluence

1. Open `strings.html` in a browser.
2. Select all (`⌘A` / `Ctrl+A`), copy.
3. In Confluence (edit mode), paste. The table should render with inline styles preserved.
4. Upload the `frames/*.png` files as page attachments.
5. (Optional) Replace the screenshot column's filename text with proper Confluence image links pointing to those attachments.

> **Honest caveat:** Confluence Cloud and Confluence Server differ in what HTML they preserve on paste. Cloud is more permissive. Test once on your instance.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | One-shot build to `figma-plugin/dist/`. |
| `npm run watch` / `npm run dev` | Rebuild on file change. Reload plugin in Figma after each change. |
| `npm run typecheck` | TypeScript noEmit check. |

---

## What's not in v1

- No round-trip from Excel/Confluence back to Figma. One-way export only.
- No Confluence API integration. HTML is generated; you paste it manually.
- No localization. Plugin uses the variable's value in the **default mode**. When localization activates (Phase 3), Figma variable modes become locale columns in the export.
- No layer-level binding metadata. The Figma variable binding *is* the binding.

---

## Repo layout

```
copy-sync/
├─ figma-plugin/
│  ├─ manifest.json
│  ├─ tsconfig.json
│  ├─ build.mjs
│  └─ src/
│     ├─ main.ts                 ← plugin sandbox: reads vars + frames, exports PNGs
│     ├─ ui.tsx                  ← React panel: collection picker + Export button
│     ├─ ui.html                 ← UI shell
│     ├─ types.ts                ← shared types
│     ├─ zip.ts                  ← bundle + browser download (jszip)
│     └─ exporters/
│        ├─ json.ts              ← strings.json
│        ├─ xlsx.ts              ← strings.xlsx (SheetJS)
│        └─ html.ts              ← strings.html (Confluence-paste-friendly)
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## Troubleshooting

- **"No string variables found"** → Add at least one `String` variable to a collection in your file, or untick collections you've excluded.
- **Plugin won't load** → Make sure you imported `figma-plugin/manifest.json` and your dist build is fresh (`npm run build`).
- **Empty `frames/` folder** → Selected variables aren't bound to any text layers. Right-click a text layer → `Apply variable`.
- **Bundle too large (>50MB)** → Many high-res frames. Phase 2 will add a 1x screenshot toggle.
