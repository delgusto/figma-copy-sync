import type { ExportPayload, FramePng, VariableEntry } from '../types';

// HTML table for local viewing of the export bundle.
//
// Confluence delivery is handled by strings.docx (Import Word document)
// or strings.xlsx (Office Excel macro) — both embed images inline.
// This HTML is the local-viewing artefact: open from the unzipped bundle
// in any browser, screenshots show via relative <img src="frames/x.png">
// paths. Browser HTML paste into Confluence drops images, so do not
// copy/paste from this file into Confluence.
//
// Layout: frame-centric rows.
//   - Grouped by top-level frame (one group per frame per collection).
//   - First row of each group: frame name + first variable.
//   - Subsequent rows: empty frame cell + next variable.
//   - Screenshot column shows the frame PNG by relative path.
//   - No rowspan — Confluence-safe (if someone pastes it anyway).
//   - Variables with no frame binding: "— (no frame)" group at the bottom.

const NO_FRAME = '— (no frame)';

export function buildHtml(payload: ExportPayload): string {
  const sections: string[] = [];

  // Group variables by collection (top-level grouping).
  const byCollection = new Map<string, VariableEntry[]>();
  for (const v of payload.variables) {
    if (!byCollection.has(v.collectionName)) byCollection.set(v.collectionName, []);
    byCollection.get(v.collectionName)!.push(v);
  }

  for (const [colName, vars] of byCollection) {
    sections.push(`<h3 style="${h3Style}">${escapeHtml(colName)}</h3>`);
    sections.push(buildFrameTable(vars, payload.modes, payload.frames));
  }

  const varCount = payload.variables.length;
  const frameCount = payload.frames.length;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(payload.fileName)} — Copy Sync export</title></head>
<body style="${bodyStyle}">
<h2 style="${h2Style}">${escapeHtml(payload.fileName)} — UX copy</h2>
<p style="${pStyle}">Exported ${escapeHtml(payload.exportedAt)} · ${varCount} string${varCount === 1 ? '' : 's'} · ${frameCount} frame${frameCount === 1 ? '' : 's'} · modes: ${payload.modes.map(escapeHtml).join(', ')}</p>
<p style="${pStyle};color:#888">Open this file from the unzipped bundle to see screenshots. For Confluence, import <code>strings.docx</code> (Word) or <code>strings.xlsx</code> — both embed images inline. Do not copy/paste from this HTML into Confluence; it drops images.</p>
${sections.join('\n')}
</body></html>`;
}

function buildFrameTable(
  vars: VariableEntry[],
  modes: string[],
  framePngs: FramePng[],
): string {
  // Build Map<frameName, VariableEntry[]> — frame-centric grouping.
  // A variable with N distinct top frames appears in N groups (correct).
  // Deduplicate: each variable appears at most once per frame group.
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

  // Sort frame groups: bound frames alphabetically, then NO_FRAME last.
  const sortedFrameNames = Array.from(frameGroups.keys())
    .filter((k) => k !== NO_FRAME)
    .sort((a, b) => a.localeCompare(b));
  if (frameGroups.has(NO_FRAME)) sortedFrameNames.push(NO_FRAME);

  // Header
  const headerCells = [
    `<th style="${thStyle};min-width:120px">Frame</th>`,
    `<th style="${thStyle};min-width:200px">Screenshot</th>`,
    `<th style="${thStyle}">Variable</th>`,
    `<th style="${thStyle}">Description</th>`,
    ...modes.map((m) => `<th style="${thStyle}">${escapeHtml(m)}</th>`),
  ].join('');

  const rows: string[] = [];

  for (const frameName of sortedFrameNames) {
    const frameVars = frameGroups.get(frameName)!;
    const framePng = frameName !== NO_FRAME
      ? framePngs.find((f) => f.name === frameName)
      : undefined;

    for (let i = 0; i < frameVars.length; i++) {
      const v = frameVars[i];
      const isFirst = i === 0;

      const groupBorder = isFirst ? 'border-top:2px solid #ccc;' : '';

      const frameTd = isFirst
        ? `<td style="${tdStyle};font-weight:500;vertical-align:top;${groupBorder}">${escapeHtml(frameName)}</td>`
        : `<td style="${tdStyle};${groupBorder}"></td>`;

      // Screenshot — relative path to frames/*.png. Shows top frame for full
      // context. Parent frame ("in context" view) is implicit since the
      // frame-centric grouping already collapses by top frame.
      let screenshotContent: string;
      if (frameName === NO_FRAME) {
        screenshotContent = '';
      } else if (framePng) {
        const src = `frames/${escapeHtml(sanitize(framePng.filename))}`;
        screenshotContent = `<img alt="${escapeHtml(frameName)}" src="${src}" style="${imgStyle}"/>`;
      } else {
        screenshotContent = `<span style="color:#aaa">no screenshot</span>`;
      }
      const screenshotTd = `<td style="${tdStyle};vertical-align:top;${groupBorder}">${screenshotContent}</td>`;

      const nameTd = `<td style="${tdStyle};vertical-align:top;${groupBorder}"><code style="${codeStyle}">${escapeHtml(v.name)}</code><div style="font-size:10px;color:#888;margin-top:2px">${escapeHtml(v.id)}</div></td>`;
      const descTd = `<td style="${tdStyle};vertical-align:top;${groupBorder}">${escapeHtml(v.description)}</td>`;
      const modeTds = modes
        .map((m) => `<td style="${tdStyle};vertical-align:top;${groupBorder}">${escapeHtml(v.values[m] ?? '')}</td>`)
        .join('');

      rows.push(`<tr>${frameTd}${screenshotTd}${nameTd}${descTd}${modeTds}</tr>`);
    }
  }

  return `<table style="${tableStyle}" cellspacing="0" cellpadding="0">
  <thead><tr>${headerCells}</tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const bodyStyle = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;margin:24px;';
const h2Style = 'font-size:20px;margin:0 0 8px;';
const h3Style = 'font-size:15px;margin:24px 0 8px;color:#333;';
const pStyle = 'color:#555;margin:0 0 12px;';
const tableStyle = 'border-collapse:collapse;width:100%;border:1px solid #ddd;font-size:13px;margin-bottom:12px;';
const thStyle = 'text-align:left;background:#f5f5f5;border:1px solid #ddd;padding:8px 10px;font-weight:600;';
const tdStyle = 'border:1px solid #ddd;padding:8px 10px;';
const codeStyle = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f5f5f5;padding:1px 4px;border-radius:3px;';
const imgStyle = 'max-width:280px;width:100%;height:auto;border:1px solid #ddd;border-radius:4px;display:block;';

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}
