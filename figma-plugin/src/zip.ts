import JSZip from 'jszip';
import type { ExportPayload, FramePng } from './types';
import { buildJson } from './exporters/json';
import { buildXlsx } from './exporters/xlsx';
import { buildHtml } from './exporters/html';
import { annotateFrameAll, annotateFrameForVariable } from './annotate';

// Build a ZIP in the UI iframe and trigger a browser download.
// All work runs client-side in the plugin's iframe.

export async function buildAndDownloadBundle(
  payload: ExportPayload,
  options: { highlight: boolean } = { highlight: true },
): Promise<void> {
  // Originals (unannotated) — keep these around for per-variable HTML annotation
  // so each row gets a screenshot that highlights ONLY that row's variable.
  const originalFrames = payload.frames;

  // 1. Frames written into the ZIP (frames/*.png).
  //    With highlight on, draw every rect color-coded so devs see all bound
  //    text in one image. Off → original PNGs unchanged.
  const zipFrames: FramePng[] = options.highlight
    ? await Promise.all(originalFrames.map((f) => annotateFrameAll(f)))
    : originalFrames;

  // 2. Per-row data URLs for strings.html.
  //    For each (frame, variable-in-that-frame), produce a PNG with only that
  //    variable's rect drawn. Cached so each (frame, variable) is rendered once.
  //    Highlight off → empty map, html.ts falls back to the unannotated frame.
  const perVarDataUrls = new Map<string, Map<string, string>>();
  if (options.highlight) {
    for (const frame of originalFrames) {
      const inner = new Map<string, string>();
      const seenVarNames = new Set<string>();
      for (const r of frame.rects) {
        if (seenVarNames.has(r.variableName)) continue;
        seenVarNames.add(r.variableName);
        const bytes = await annotateFrameForVariable(frame, r.variableName);
        inner.set(r.variableName, bytesToDataUrl(bytes));
      }
      if (inner.size) perVarDataUrls.set(frame.name, inner);
    }
  }

  // Build outputs.
  const html = buildHtml(payload, perVarDataUrls);
  // Confluence-safe version: no embedded images (data: URLs stripped on paste).
  // Upload frames/*.png as page attachments to get screenshots in Confluence.
  const htmlConfluence = buildHtml(payload, new Map(), true);

  const zip = new JSZip();
  zip.file('strings.json', buildJson(payload));
  zip.file('strings.xlsx', buildXlsx(payload));
  zip.file('strings.html', html);
  zip.file('strings-confluence.html', htmlConfluence);

  const framesDir = zip.folder('frames');
  if (framesDir) {
    for (const frame of zipFrames) {
      framesDir.file(frame.filename, frame.bytes as unknown as Uint8Array);
    }
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = bundleName(payload);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function bytesToDataUrl(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function bundleName(payload: ExportPayload): string {
  const stamp = payload.exportedAt.replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const safeName = payload.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'figma-file';
  return `copy-sync-${safeName}-${stamp}.zip`;
}
