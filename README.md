# Copy Sync

One source of truth for UX copy, synced one-way into Figma designs (and later, web apps). Writers edit copy in one place; designers pull the latest into their Figma file with one click.

This repo is the **tracer-bullet slice**: a working Figma plugin + a tiny local mock API backed by JSON files. It proves the end-to-end loop — *edit → refresh → update* — before we plug in the real Excel / SharePoint backend.

See [the plan](/Users/davidgustafson/.claude/plans/i-want-to-build-keen-comet.md) for the full roadmap.

---

## What's in this slice

```
copy-sync/
├─ mock-data/
│  ├─ checkout.json       ← edit me, designer hits "Refresh" in Figma
│  └─ onboarding.json
├─ mock-server.mjs        ← tiny Node HTTP server (port 3737)
├─ figma-plugin/
│  ├─ manifest.json       ← load this in Figma
│  ├─ src/
│  │  ├─ main.ts          ← plugin sandbox code
│  │  ├─ ui.tsx           ← React UI
│  │  ├─ ui.html          ← UI shell
│  │  └─ types.ts         ← shared types
│  └─ build.mjs           ← esbuild config
└─ dist/                  ← build output (loaded by Figma)
```

---

## Setup

Prereqs: Node 18+, Figma desktop app.

```bash
npm install
npm run build
```

---

## Run the demo

1. **Start the mock server** (serves the JSON files as if it were the real API):
   ```bash
   npm run server
   ```
   You should see `mock-server listening on http://localhost:3737`.

2. **Load the plugin in Figma desktop**:
   - `Plugins` → `Development` → `Import plugin from manifest…`
   - Pick `copy-sync/figma-plugin/manifest.json`.

3. **Open any Figma file** and run the plugin: `Plugins` → `Development` → `Copy Sync`.

4. **First run:** pick a project (e.g. *Checkout*). The file now locks to that project's namespace.

5. **Bind a text layer:**
   - Select a text layer on the canvas.
   - In the plugin panel, pick a string from the list (or filter it).
   - Click **bind to selection**. The layer now stores the string ID as invisible metadata.

6. **Refresh:**
   - Change `en` on a string in `mock-data/checkout.json` (save the file).
   - In Figma, click **Refresh selection** (or **Refresh page** to update all bound layers at once).
   - The text on the canvas updates.

> **Tip:** during development run `npm run dev` to watch + rebuild on change. You'll still need to close and re-run the plugin in Figma to pick up new builds.

---

## What's wired up

- **Binding:** each bound text layer stores its string ID via `node.setPluginData('copySyncStringId', …)`. Duplicating or renaming the layer preserves the binding.
- **File ↔ project lock:** the Figma file stores its project ID on the document root (`figma.root`). The plugin only shows strings for the bound project.
- **Status gate:** only strings with `status: approved` or `live` are applied. `draft` and `review` are visible in the plugin but don't update canvas copy.
- **Missing IDs:** a bound layer whose ID no longer exists in the JSON is reported in the toast, not silently skipped.
- **Fonts:** the plugin loads the layer's font(s) before rewriting text, so mixed-font ranges don't break.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | One-shot build into `dist/`. |
| `npm run watch` | Rebuild on file change. |
| `npm run server` | Start mock API on `:3737`. |
| `npm run dev` | Run `server` + `watch` together. |
| `npm run typecheck` | TypeScript noEmit check. |

---

## Next up (Phase 1 MVP)

Replace the JSON-backed mock server with the real one:

1. Stand up a Next.js App Router service (`apps/api`).
2. Add Microsoft Graph client to read an Excel workbook on SharePoint.
3. Poll / ingest to a Postgres cache. Serve the same endpoints the plugin already calls.
4. Swap `MOCK_SERVER` in the plugin UI for the real service URL.

Everything else (the plugin, the binding model, the refresh flow) stays put.

---

## Troubleshooting

- **"Server error" banner** → mock server isn't running. `npm run server`.
- **Figma doesn't see the plugin** → make sure you used *Import from manifest* and pointed at `figma-plugin/manifest.json`, not a built file.
- **Plugin opens blank** → rebuild (`npm run build`), then re-run the plugin.
- **`networkAccess` error** → production builds will need the real server URL added to `manifest.json > networkAccess.allowedDomains`.
