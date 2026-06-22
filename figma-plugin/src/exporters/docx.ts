// DOCX writer with embedded per-variable annotated screenshots.
//
// Confluence path: user imports this .docx via Confluence's "Import Word
// document" action. Embedded images come through as page attachments
// rendered inline — same outcome as copy/paste from Word, but no app
// install required.
//
// Layout mirrors strings.xlsx / strings.html: collection sections, each
// containing a frame-centric table (one row per (frame, variable)).

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  BorderStyle,
  ShadingType,
  VerticalAlign,
} from 'docx';
import type { ExportPayload, VariableEntry } from '../types';

const NO_FRAME = '— (no frame)';

const IMAGE_PX_WIDTH = 280;
const IMAGE_PX_HEIGHT = 130;

// Table column widths in DXA (1/20 of a point). Page width ~ 12240 DXA
// (US Letter, full width minus margins ≈ 9000 DXA). Distribute:
//   Frame 1400, Screenshot 3000, Variable 1800, Description 1800, modes share rest.
const FRAME_W = 1400;
const SCREENSHOT_W = 3000;
const VAR_W = 1800;
const DESC_W = 1800;

const BORDER = {
  style: BorderStyle.SINGLE,
  size: 4, // 1/8 pt units → 0.5pt
  color: 'DDDDDD',
};
const GROUP_BORDER = {
  style: BorderStyle.SINGLE,
  size: 8,
  color: 'CCCCCC',
};
const HEADER_SHADING = {
  type: ShadingType.CLEAR,
  color: 'auto',
  fill: 'F5F5F5',
};

export async function buildDocx(
  payload: ExportPayload,
  perVarBytes: Map<string, Map<string, Uint8Array>>,
): Promise<Uint8Array> {
  const children: Array<Paragraph | Table> = [];

  // Title
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${payload.fileName} — UX copy`, bold: true })],
    }),
  );

  const varCount = payload.variables.length;
  const frameCount = payload.frames.length;
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text:
            `Exported ${payload.exportedAt} · ${varCount} string${varCount === 1 ? '' : 's'} · ` +
            `${frameCount} frame${frameCount === 1 ? '' : 's'} · modes: ${payload.modes.join(', ')}`,
          color: '555555',
          size: 20, // half-points → 10pt
        }),
      ],
    }),
  );

  // Group by collection
  const byCollection = new Map<string, VariableEntry[]>();
  for (const v of payload.variables) {
    if (!byCollection.has(v.collectionName)) byCollection.set(v.collectionName, []);
    byCollection.get(v.collectionName)!.push(v);
  }

  for (const [colName, vars] of byCollection) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: colName, bold: true })],
        spacing: { before: 240, after: 120 },
      }),
    );
    children.push(buildFrameTable(vars, payload.modes, perVarBytes));
    // Spacer so consecutive tables don't merge visually.
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

  const doc = new Document({
    creator: 'Copy Sync',
    title: `${payload.fileName} — UX copy`,
    sections: [{ children }],
  });

  // Use toBlob, not toBuffer: toBuffer references Node's Buffer global, which
  // doesn't exist in the Figma plugin UI iframe ("node buffer is not supported
  // by this platform"). toBlob is the browser path; convert Blob -> Uint8Array.
  const blob = await Packer.toBlob(doc);
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

function buildFrameTable(
  vars: VariableEntry[],
  modes: string[],
  perVarBytes: Map<string, Map<string, Uint8Array>>,
): Table {
  // Frame-centric grouping — same as html.ts / xlsx.ts.
  const frameGroups = new Map<string, VariableEntry[]>();
  for (const v of vars) {
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

  // Mode column width — share remaining width across modes.
  const modeColW = Math.max(1200, Math.floor((9000 - FRAME_W - SCREENSHOT_W - VAR_W - DESC_W) / Math.max(modes.length, 1)));

  const rows: TableRow[] = [];

  // Header row
  rows.push(
    new TableRow({
      tableHeader: true,
      children: [
        headerCell('Frame', FRAME_W),
        headerCell('Screenshot', SCREENSHOT_W),
        headerCell('Variable', VAR_W),
        headerCell('Description', DESC_W),
        ...modes.map((m) => headerCell(m, modeColW)),
      ],
    }),
  );

  for (const frameName of sortedFrameNames) {
    const frameVars = frameGroups.get(frameName)!;
    for (let i = 0; i < frameVars.length; i++) {
      const v = frameVars[i];
      const isFirst = i === 0;

      const imageBytes =
        frameName !== NO_FRAME ? perVarBytes.get(frameName)?.get(v.id) : undefined;

      rows.push(
        new TableRow({
          children: [
            dataCell(
              [paragraph(isFirst ? frameName : '', { bold: isFirst })],
              FRAME_W,
              isFirst,
            ),
            dataCell(
              imageBytes ? [imageParagraph(imageBytes)] : [paragraph('')],
              SCREENSHOT_W,
              isFirst,
            ),
            dataCell([paragraph(v.id, { font: 'Courier New', size: 18 })], VAR_W, isFirst),
            dataCell([paragraph(v.description)], DESC_W, isFirst),
            ...modes.map((m) =>
              dataCell([paragraph(v.values[m] ?? '')], modeColW, isFirst),
            ),
          ],
        }),
      );
    }
  }

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows,
    borders: {
      top: BORDER,
      bottom: BORDER,
      left: BORDER,
      right: BORDER,
      insideHorizontal: BORDER,
      insideVertical: BORDER,
    },
  });
}

function headerCell(text: string, widthDxa: number): TableCell {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: HEADER_SHADING,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: true, size: 20 })],
      }),
    ],
  });
}

function dataCell(
  children: Paragraph[],
  widthDxa: number,
  groupTop: boolean,
): TableCell {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    borders: groupTop
      ? {
          top: GROUP_BORDER,
          bottom: BORDER,
          left: BORDER,
          right: BORDER,
        }
      : undefined,
    children,
  });
}

function paragraph(
  text: string,
  opts: { bold?: boolean; font?: string; size?: number } = {},
): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        font: opts.font,
        size: opts.size ?? 20, // 10pt default
      }),
    ],
  });
}

function imageParagraph(bytes: Uint8Array): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [
      new ImageRun({
        data: bytes,
        transformation: { width: IMAGE_PX_WIDTH, height: IMAGE_PX_HEIGHT },
        type: 'png',
      }),
    ],
  });
}
