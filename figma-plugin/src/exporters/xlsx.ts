// XLSX writer with embedded per-variable annotated screenshots.
// Uses ExcelJS for image embedding (SheetJS doesn't support it).
//
// Layout mirrors strings.html: frame-centric rows, one row per (frame, variable).
// First row of each frame group has the frame name. All rows in a group
// have the variable's annotated screenshot in the Screenshot column.
//
// This XLSX is designed to be imported into a Confluence page via the
// Office Excel macro — images render inline, table preserves formatting.

import ExcelJS from 'exceljs';
import type { ExportPayload, VariableEntry, TeamMember } from '../types';

const NO_FRAME = '— (no frame)';

// Image cell dimensions (approx pixels). ExcelJS uses these for the
// `ext` of `addImage`, and we size the row + column to match so it fits.
const IMAGE_PX_WIDTH = 280;
const IMAGE_PX_HEIGHT = 130;
const ROW_HEIGHT_POINTS = 110; // ~146 pixels — slightly bigger than image so it has margin
// Column widths use Excel's char-width units. Rough conversion:
// 1 char ≈ 7 pixels for the default font. So 40 chars ≈ 280px.
const SCREENSHOT_COL_WIDTH_CHARS = 42;

export async function buildXlsx(
  payload: ExportPayload,
  perVarBytes: Map<string, Map<string, Uint8Array>>,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Copy Sync';
  wb.created = new Date(payload.exportedAt);

  // Team sheet first, so it's the start of the workbook (skip if empty).
  addTeamSheet(wb, payload.team);

  const ws = wb.addWorksheet('strings', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // ── Column definitions ──────────────────────────────────────────────────
  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'Frame', key: 'frame', width: 28 },
    { header: 'Screenshot', key: 'screenshot', width: SCREENSHOT_COL_WIDTH_CHARS },
    { header: 'Variable', key: 'variable', width: 32 },
    { header: 'Description', key: 'description', width: 32 },
    ...payload.modes.map((m) => ({ header: m, key: `mode_${m}`, width: 26 })),
  ];
  ws.columns = columns;

  // ── Header styling ──────────────────────────────────────────────────────
  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.font = { bold: true, size: 11, color: { argb: 'FF1A1A1A' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      right: { style: 'thin', color: { argb: 'FFDDDDDD' } },
    };
  });

  // ── Build frame-grouped data (same logic as html.ts) ────────────────────
  const frameGroups = new Map<string, VariableEntry[]>();
  for (const v of payload.variables) {
    const topFrameNames = v.occurrences.length
      ? Array.from(new Set(v.occurrences.map((o) => o.topFrameName)))
      : [];
    if (topFrameNames.length === 0) {
      if (!frameGroups.has(NO_FRAME)) frameGroups.set(NO_FRAME, []);
      frameGroups.get(NO_FRAME)!.push(v);
    } else {
      for (const fn of topFrameNames) {
        if (!frameGroups.has(fn)) frameGroups.set(fn, []);
        const group = frameGroups.get(fn)!;
        if (!group.some((g) => g.id === v.id)) group.push(v);
      }
    }
  }

  const sortedFrameNames = Array.from(frameGroups.keys())
    .filter((k) => k !== NO_FRAME)
    .sort((a, b) => a.localeCompare(b));
  if (frameGroups.has(NO_FRAME)) sortedFrameNames.push(NO_FRAME);

  // ── Row writing ─────────────────────────────────────────────────────────
  const thinBorder = { style: 'thin' as const, color: { argb: 'FFDDDDDD' } };
  const groupTopBorder = { style: 'medium' as const, color: { argb: 'FFCCCCCC' } };

  for (const frameName of sortedFrameNames) {
    const frameVars = frameGroups.get(frameName)!;

    for (let i = 0; i < frameVars.length; i++) {
      const v = frameVars[i];
      const isFirst = i === 0;

      const rowValues: Record<string, string> = {
        frame: isFirst ? frameName : '',
        screenshot: '', // image inserted below
        variable: v.id, // canonical full path — used for import matching
        description: v.description,
      };
      for (const m of payload.modes) {
        rowValues[`mode_${m}`] = v.values[m] ?? '';
      }

      const row = ws.addRow(rowValues);
      row.height = ROW_HEIGHT_POINTS;

      // Apply per-cell styling: top-aligned + wrap text + thin borders.
      // Group separator: medium top border on every cell of the first row.
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
        cell.border = {
          top: isFirst ? groupTopBorder : thinBorder,
          bottom: thinBorder,
          left: thinBorder,
          right: thinBorder,
        };
        cell.font = { size: 10 };
      });

      // Variable column in monospace for canonical paths.
      row.getCell('variable').font = { size: 10, name: 'Courier New' };
      // Frame column bold (first row of group).
      if (isFirst) {
        row.getCell('frame').font = { size: 10, bold: true };
      }

      // Embed per-variable annotated PNG, if available.
      if (frameName !== NO_FRAME) {
        const bytes = perVarBytes.get(frameName)?.get(v.id);
        if (bytes) {
          const imageId = wb.addImage({
            // ExcelJS accepts Uint8Array or ArrayBuffer or base64. Uint8Array works.
            buffer: bytes as unknown as ExcelJS.Buffer,
            extension: 'png',
          });
          // tl = top-left anchor. Col 1 = Screenshot (B). Row is 0-indexed in tl.
          ws.addImage(imageId, {
            tl: { col: 1, row: row.number - 1 },
            ext: { width: IMAGE_PX_WIDTH, height: IMAGE_PX_HEIGHT },
            editAs: 'oneCell',
          });
        }
      }
    }
  }

  // ── Meta sheet for traceability ─────────────────────────────────────────
  const meta = wb.addWorksheet('_meta');
  meta.columns = [
    { header: 'key', key: 'k', width: 20 },
    { header: 'value', key: 'v', width: 60 },
  ];
  meta.addRows([
    { k: 'exportedAt', v: payload.exportedAt },
    { k: 'fileName', v: payload.fileName },
    { k: 'fileKey', v: payload.fileKey },
    { k: 'modes', v: payload.modes.join(', ') },
    { k: 'variableCount', v: String(payload.variables.length) },
    { k: 'frameCount', v: String(payload.frames.length) },
  ]);

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

// Team tab at the front of the workbook: Role | Name. No-op if empty.
function addTeamSheet(wb: ExcelJS.Workbook, team: TeamMember[] | undefined): void {
  const members = (team ?? []).filter((m) => m.role.trim() || m.name.trim());
  if (!members.length) return;

  const ws = wb.addWorksheet('Team', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Role', key: 'role', width: 32 },
    { header: 'Name', key: 'name', width: 36 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.font = { bold: true, size: 11, color: { argb: 'FF1A1A1A' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  const border = {
    top: { style: 'thin' as const, color: { argb: 'FFDDDDDD' } },
    bottom: { style: 'thin' as const, color: { argb: 'FFDDDDDD' } },
    left: { style: 'thin' as const, color: { argb: 'FFDDDDDD' } },
    right: { style: 'thin' as const, color: { argb: 'FFDDDDDD' } },
  };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    cell.border = border;
  });

  for (const m of members) {
    const row = ws.addRow({ role: m.role, name: m.name });
    row.eachCell((cell) => {
      cell.border = border;
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  }
}
