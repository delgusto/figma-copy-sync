import * as XLSX from 'xlsx';
import type { ExportPayload } from '../types';

// XLSX with one row per variable. Stakeholder-friendly columns.
export function buildXlsx(payload: ExportPayload): Uint8Array {
  const rows = payload.variables.map((v) => ({
    id: v.id,
    description: v.description,
    value: v.value,
    collection: v.collectionName,
    frames: v.frames.join(', '),
    screenshot_files: v.frames.map((f) => `frames/${sanitize(f)}.png`).join(', '),
  }));

  const headerOrder = ['id', 'description', 'value', 'collection', 'frames', 'screenshot_files'];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headerOrder });

  // Reasonable default column widths.
  sheet['!cols'] = [
    { wch: 36 }, // id
    { wch: 40 }, // description
    { wch: 40 }, // value
    { wch: 18 }, // collection
    { wch: 30 }, // frames
    { wch: 36 }, // screenshot_files
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'strings');

  // Meta sheet for traceability.
  const meta = XLSX.utils.aoa_to_sheet([
    ['exportedAt', payload.exportedAt],
    ['fileName', payload.fileName],
    ['fileKey', payload.fileKey],
    ['variableCount', payload.variables.length],
    ['frameCount', payload.frames.length],
  ]);
  XLSX.utils.book_append_sheet(wb, meta, '_meta');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out);
}

function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}
