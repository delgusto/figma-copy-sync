import JSZip from 'jszip';
import type { ExportPayload } from './types';
import { buildJson } from './exporters/json';
import { buildXlsx } from './exporters/xlsx';
import { buildHtml } from './exporters/html';

// Build a ZIP in the UI iframe and trigger a browser download.
// All work runs client-side in the plugin's iframe.

export async function buildAndDownloadBundle(payload: ExportPayload): Promise<void> {
  const zip = new JSZip();

  zip.file('strings.json', buildJson(payload));
  zip.file('strings.xlsx', buildXlsx(payload));
  zip.file('strings.html', buildHtml(payload));

  const framesDir = zip.folder('frames');
  if (framesDir) {
    for (const frame of payload.frames) {
      framesDir.file(frame.filename, frame.bytes);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = bundleName(payload);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function bundleName(payload: ExportPayload): string {
  const stamp = payload.exportedAt.replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const safeName = payload.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'figma-file';
  return `copy-sync-${safeName}-${stamp}.zip`;
}
