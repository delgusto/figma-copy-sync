import JSZip from 'jszip';
import type { ExportPayload, FramePng } from './types';
import { buildJson } from './exporters/json';
import { buildXlsx } from './exporters/xlsx';
import { buildDocx } from './exporters/docx';
import { buildHtml } from './exporters/html';
import {
  annotateFrameAll,
  annotateFrameForVariable,
  cropFrameForVariable,
  type CropResult,
} from './annotate';

// Build a ZIP in the UI iframe and trigger a browser download.
// All work runs client-side in the plugin's iframe.

export async function buildAndDownloadBundle(
  payload: ExportPayload,
  options: { highlight: boolean } = { highlight: true },
): Promise<void> {
  // Originals (unannotated) — needed to generate per-variable annotated
  // crops for the XLSX, distinct from the all-rects-annotated PNGs in frames/.
  const originalFrames = payload.frames;

  // 1. Frames written into the ZIP (frames/*.png).
  //    With highlight on, draw every rect color-coded so devs see all bound
  //    text in one image. Off → original PNGs unchanged.
  const zipFrames: FramePng[] = options.highlight
    ? await Promise.all(originalFrames.map((f) => annotateFrameAll(f)))
    : originalFrames;

  // 2. Per-variable annotated PNG bytes — used by xlsx.ts to embed one image
  //    per (frame, variable) row with only that variable's rect highlighted.
  //    Highlight off → empty map, XLSX rows get no embedded screenshots.
  const perVarBytes = new Map<string, Map<string, Uint8Array>>();
  // Zoomed close-up crops, keyed the same way. DOCX stacks these above the
  // full-frame shot so reviewers get a readable view of the copy item.
  const perVarCrop = new Map<string, Map<string, CropResult>>();
  if (options.highlight) {
    for (const frame of originalFrames) {
      const inner = new Map<string, Uint8Array>();
      const innerCrop = new Map<string, CropResult>();
      const seenVarNames = new Set<string>();
      for (const r of frame.rects) {
        if (seenVarNames.has(r.variableName)) continue;
        seenVarNames.add(r.variableName);
        const bytes = await annotateFrameForVariable(frame, r.variableName);
        // key by canonical variable name (matches VariableEntry.id)
        inner.set(r.variableName, bytes);
        const crop = await cropFrameForVariable(frame, r.variableName);
        if (crop) innerCrop.set(r.variableName, crop);
      }
      if (inner.size) perVarBytes.set(frame.name, inner);
      if (innerCrop.size) perVarCrop.set(frame.name, innerCrop);
    }
  }

  // Build outputs.
  // HTML references frames/*.png by relative path (no base64 embedding).
  // XLSX is the Confluence-friendly artefact — embeds per-variable PNGs inline.
  const html = buildHtml(payload);
  const xlsx = await buildXlsx(payload, perVarBytes);
  const docx = await buildDocx(payload, perVarBytes, perVarCrop);

  const zip = new JSZip();
  zip.file('strings.json', buildJson(payload));
  zip.file('strings.xlsx', xlsx);
  zip.file('strings.docx', docx);
  zip.file('strings.html', html);

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

function bundleName(payload: ExportPayload): string {
  const stamp = payload.exportedAt.replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const safeName = payload.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'figma-file';
  return `copy-sync-${safeName}-${stamp}.zip`;
}
