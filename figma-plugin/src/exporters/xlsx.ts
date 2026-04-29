import * as XLSX from 'xlsx';
import type { ExportPayload, VariableEntry } from '../types';

// XLSX with one row per variable. One column per mode.
// Columns: collection, group, name, description, <mode 1>, <mode 2>, ..., frames, screenshots.
export function buildXlsx(payload: ExportPayload): Uint8Array {
  const headers = [
    'collection',
    'group',
    'name',
    'id',
    'description',
    ...payload.modes,
    'frames',
    'screenshot_files',
  ];

  const aoa: (string | number)[][] = [headers];
  for (const v of payload.variables) {
    aoa.push([
      v.collectionName,
      v.group,
      v.name,
      v.id,
      v.description,
      ...payload.modes.map((m) => v.values[m] ?? ''),
      v.frames.join(', '),
      v.frames.map((f) => `frames/${sanitize(f)}.png`).join(', '),
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const colWidths = [
    { wch: 18 }, // collection
    { wch: 24 }, // group
    { wch: 24 }, // name
    { wch: 36 }, // id
    { wch: 40 }, // description
    ...payload.modes.map(() => ({ wch: 36 })),
    { wch: 30 }, // frames
    { wch: 36 }, // screenshot_files
  ];
  sheet['!cols'] = colWidths;
  // Freeze header row.
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 } as any;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'strings');

  // Optional per-collection sheets if there is more than one collection.
  const byCollection = new Map<string, VariableEntry[]>();
  for (const v of payload.variables) {
    if (!byCollection.has(v.collectionName)) byCollection.set(v.collectionName, []);
    byCollection.get(v.collectionName)!.push(v);
  }
  if (byCollection.size > 1) {
    for (const [colName, vars] of byCollection) {
      const sheetAoa: (string | number)[][] = [headers];
      for (const v of vars) {
        sheetAoa.push([
          v.collectionName,
          v.group,
          v.name,
          v.id,
          v.description,
          ...payload.modes.map((m) => v.values[m] ?? ''),
          v.frames.join(', '),
          v.frames.map((f) => `frames/${sanitize(f)}.png`).join(', '),
        ]);
      }
      const colSheet = XLSX.utils.aoa_to_sheet(sheetAoa);
      colSheet['!cols'] = colWidths;
      colSheet['!freeze'] = { xSplit: 0, ySplit: 1 } as any;
      XLSX.utils.book_append_sheet(wb, colSheet, sheetNameSafe(colName));
    }
  }

  // Meta sheet for traceability.
  const meta = XLSX.utils.aoa_to_sheet([
    ['exportedAt', payload.exportedAt],
    ['fileName', payload.fileName],
    ['fileKey', payload.fileKey],
    ['modes', payload.modes.join(', ')],
    ['variableCount', payload.variables.length],
    ['frameCount', payload.frames.length],
  ]);
  XLSX.utils.book_append_sheet(wb, meta, '_meta');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

// Excel sheet names: max 31 chars, no : \ / ? * [ ]
function sheetNameSafe(name: string): string {
  return name.replace(/[:\\/?*\[\]]/g, '_').slice(0, 31) || 'sheet';
}
