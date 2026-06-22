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
  CheckBox,
} from 'docx';
import type { ExportPayload, VariableEntry, FramePng, TeamMember } from '../types';
import type { CropResult } from '../annotate';

const NO_FRAME = '— (no frame)';

// Display widths for embedded images (px). Heights derive from each image's
// true aspect ratio so nothing is squished.
const MAX_IMG_W = 280; // in-context full frame: cap, never upscale
const CROP_DISPLAY_W = 320; // zoomed crop: fixed target, upscaled if small

// In-context shot: cap at maxW, never enlarge past native size.
function scaleToWidth(
  w: number,
  h: number,
  maxW = MAX_IMG_W,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: maxW, height: Math.round(maxW * 0.5) };
  const width = Math.min(maxW, w);
  return { width, height: Math.max(1, Math.round(width * (h / w))) };
}

// Zoomed crop: render at a fixed target width regardless of native size, so
// small crops are enlarged and read clearly in the doc.
function scaleToTargetWidth(
  w: number,
  h: number,
  targetW = CROP_DISPLAY_W,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: targetW, height: Math.round(targetW * 0.5) };
  return { width: targetW, height: Math.max(1, Math.round(targetW * (h / w))) };
}

// Table column widths in DXA (1/20 of a point). With the review columns the
// table is wider than one page — that's expected; Word/Confluence scroll it.
const FRAME_W = 1400;
const SCREENSHOT_W = 3000;
const VAR_W = 1800;
const DESC_W = 1800;
const MODE_W = 1800; // each mode / Copy column
// Review columns reviewers fill in by hand.
const AX_W = 1600; // Accessibility
const COMMENTS_W = 2200; // Comments
const SIGNOFF_W = 1900; // Sign off (fits "Compliance" + checkbox)

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
  perVarCrop: Map<string, Map<string, CropResult>> = new Map(),
): Promise<Uint8Array> {
  // Frame dimensions by name, so the in-context shot keeps its aspect ratio.
  const frameByName = new Map<string, FramePng>();
  for (const f of payload.frames) frameByName.set(f.name, f);
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

  // Team table (skip rows with neither role nor name).
  const team = (payload.team ?? []).filter((m) => m.role.trim() || m.name.trim());
  if (team.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: 'Team', bold: true })],
        spacing: { before: 240, after: 120 },
      }),
    );
    children.push(buildTeamTable(team));
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

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
    children.push(buildFrameTable(vars, payload.modes, perVarBytes, perVarCrop, frameByName));
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

function buildTeamTable(team: TeamMember[]): Table {
  const ROLE_W = 2600;
  const NAME_W = 4000;
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [headerCell('Role', ROLE_W), headerCell('Name', NAME_W)],
    }),
    ...team.map(
      (m) =>
        new TableRow({
          children: [
            dataCell([paragraph(m.role)], ROLE_W, false),
            dataCell([paragraph(m.name)], NAME_W, false),
          ],
        }),
    ),
  ];
  return new Table({
    width: { size: ROLE_W + NAME_W, type: WidthType.DXA },
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

function buildFrameTable(
  vars: VariableEntry[],
  modes: string[],
  perVarBytes: Map<string, Map<string, Uint8Array>>,
  perVarCrop: Map<string, Map<string, CropResult>>,
  frameByName: Map<string, FramePng>,
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

  const modeColW = MODE_W;
  // Single mode → label the value column "Copy"; multiple → keep mode names.
  const modeHeader = (m: string): string => (modes.length === 1 ? 'Copy' : m);
  const tableWidth =
    FRAME_W + SCREENSHOT_W + VAR_W + DESC_W + modes.length * modeColW + AX_W + COMMENTS_W + SIGNOFF_W;

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
        ...modes.map((m) => headerCell(modeHeader(m), modeColW)),
        headerCell('Accessibility', AX_W),
        headerCell('Comments', COMMENTS_W),
        headerCell('Sign off', SIGNOFF_W),
      ],
    }),
  );

  for (const frameName of sortedFrameNames) {
    const frameVars = frameGroups.get(frameName)!;
    for (let i = 0; i < frameVars.length; i++) {
      const v = frameVars[i];
      const isFirst = i === 0;

      const crop = frameName !== NO_FRAME ? perVarCrop.get(frameName)?.get(v.id) : undefined;
      const imageBytes =
        frameName !== NO_FRAME ? perVarBytes.get(frameName)?.get(v.id) : undefined;
      const frame = frameByName.get(frameName);

      // Screenshot cell: zoomed close-up on top (readable copy), then the
      // full-frame "in context" shot below. Both kept aspect-correct.
      const screenshotChildren: Paragraph[] = [];
      if (crop) {
        screenshotChildren.push(captionParagraph('Zoomed'));
        screenshotChildren.push(imageParagraph(crop.bytes, scaleToTargetWidth(crop.width, crop.height)));
      }
      if (imageBytes) {
        screenshotChildren.push(captionParagraph('In context'));
        screenshotChildren.push(
          imageParagraph(
            imageBytes,
            scaleToWidth(frame?.width ?? MAX_IMG_W, frame?.height ?? MAX_IMG_W * 0.5),
          ),
        );
      }
      if (!screenshotChildren.length) screenshotChildren.push(paragraph(''));

      rows.push(
        new TableRow({
          children: [
            dataCell(
              [paragraph(isFirst ? frameName : '', { bold: isFirst })],
              FRAME_W,
              isFirst,
            ),
            dataCell(screenshotChildren, SCREENSHOT_W, isFirst),
            dataCell([paragraph(v.id, { font: 'Courier New', size: 18 })], VAR_W, isFirst),
            dataCell([paragraph(v.description)], DESC_W, isFirst),
            ...modes.map((m) =>
              dataCell([paragraph(v.values[m] ?? '')], modeColW, isFirst),
            ),
            dataCell([paragraph('')], AX_W, isFirst),
            dataCell([paragraph('')], COMMENTS_W, isFirst),
            dataCell(
              [checkboxParagraph('Editor'), checkboxParagraph('Compliance')],
              SIGNOFF_W,
              isFirst,
            ),
          ],
        }),
      );
    }
  }

  return new Table({
    width: { size: tableWidth, type: WidthType.DXA },
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

function imageParagraph(
  bytes: Uint8Array,
  dims: { width: number; height: number },
): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [
      new ImageRun({
        data: bytes,
        transformation: { width: dims.width, height: dims.height },
        type: 'png',
      }),
    ],
  });
}

// A labelled interactive Word checkbox (legacy form-field content control).
// Survives import into Confluence as a checkbox, per testing.
function checkboxParagraph(label: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [new CheckBox({ checked: false }), new TextRun({ text: ` ${label}`, size: 18 })],
  });
}

function captionParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 40, after: 20 },
    children: [new TextRun({ text, size: 14, color: '888888', bold: true })],
  });
}
