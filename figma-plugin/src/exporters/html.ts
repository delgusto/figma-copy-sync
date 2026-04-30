import type { ExportPayload, FramePng, VariableEntry } from '../types';

// HTML table designed to survive copy-paste into Confluence Cloud.
// All styling inline because Confluence's storage format strips <style> blocks.
// Frame screenshots are embedded as data: URLs so a single paste carries
// the images with it — no manual attachment step.

/**
 * @param perVarDataUrls  Map<frameName, Map<variableName, dataUrl>> — one
 *   image per (frame, variable) pair, each highlighting only that variable.
 *   Falls back to the unannotated frame if a row has no entry.
 */
export function buildHtml(
  payload: ExportPayload,
  perVarDataUrls: Map<string, Map<string, string>> = new Map(),
): string {
  // Fallback (unannotated) frame data URL keyed by frame name.
  const frameDataUrls = new Map<string, string>();
  for (const frame of payload.frames) {
    frameDataUrls.set(frame.name, bytesToDataUrl(frame.bytes));
  }

  const sections: string[] = [];

  // Group by collection, then by group path within collection.
  const byCollection = new Map<string, VariableEntry[]>();
  for (const v of payload.variables) {
    if (!byCollection.has(v.collectionName)) byCollection.set(v.collectionName, []);
    byCollection.get(v.collectionName)!.push(v);
  }

  for (const [colName, vars] of byCollection) {
    sections.push(`<h3 style="${h3Style}">${escapeHtml(colName)}</h3>`);
    sections.push(buildSectionTable(vars, payload.modes, frameDataUrls, perVarDataUrls));
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(payload.fileName)} — Copy Sync export</title></head>
<body style="${bodyStyle}">
<h2 style="${h2Style}">${escapeHtml(payload.fileName)} — UX copy</h2>
<p style="${pStyle}">Exported ${escapeHtml(payload.exportedAt)} · ${payload.variables.length} string${payload.variables.length === 1 ? '' : 's'} · ${payload.frames.length} frame${payload.frames.length === 1 ? '' : 's'} · modes: ${payload.modes.map(escapeHtml).join(', ')}</p>
<p style="${pStyle}"><strong>To use in Confluence:</strong> select this whole page (⌘A / Ctrl+A), copy, paste into a Confluence page in edit mode. Then upload <code>frames/*.png</code> as page attachments and link them in the screenshots column.</p>
${sections.join('\n')}
</body></html>`;
}

function buildSectionTable(
  vars: VariableEntry[],
  modes: string[],
  frameDataUrls: Map<string, string>,
  perVarDataUrls: Map<string, Map<string, string>>,
): string {
  // Sub-group within a collection by `group` path; emit a sub-heading row per group.
  const byGroup = new Map<string, VariableEntry[]>();
  for (const v of vars) {
    const key = v.group || '';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(v);
  }

  const headerCells = [
    `<th style="${thStyle}">Name</th>`,
    `<th style="${thStyle}">Description</th>`,
    `<th style="${thStyle}">Screenshots</th>`,
    ...modes.map((m) => `<th style="${thStyle}">${escapeHtml(m)}</th>`),
    `<th style="${thStyle}">Frames</th>`,
  ].join('');

  const rows: string[] = [];
  for (const [group, list] of byGroup) {
    if (group) {
      rows.push(
        `<tr><td colspan="${modes.length + 4}" style="${groupRowStyle}">${escapeHtml(group)}</td></tr>`,
      );
    }
    for (const v of list) {
      const occurrences = v.occurrences.length
        ? v.occurrences
        : v.frames.map((f) => ({ topFrameName: f, parentFrameName: f }));

      const screenshots = occurrences
        .map((occ) => renderOccurrence(occ, v.id, frameDataUrls, perVarDataUrls))
        .join('');

      rows.push(`
        <tr>
          <td style="${tdStyle}"><code style="${codeStyle}">${escapeHtml(v.name)}</code><div style="font-size:10px;color:#888;margin-top:2px">${escapeHtml(v.id)}</div></td>
          <td style="${tdStyle}">${escapeHtml(v.description)}</td>
          <td style="${tdStyle}">${screenshots || '<span style="color:#aaa">—</span>'}</td>
          ${modes.map((m) => `<td style="${tdStyle}">${escapeHtml(v.values[m] ?? '')}</td>`).join('')}
          <td style="${tdStyle}">${escapeHtml(v.frames.join(', '))}</td>
        </tr>`);
    }
  }

  return `<table style="${tableStyle}" cellspacing="0" cellpadding="0">
  <thead><tr>${headerCells}</tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>`;
}

const bodyStyle = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;margin:24px;';
const h2Style = 'font-size:20px;margin:0 0 8px;';
const h3Style = 'font-size:15px;margin:24px 0 8px;color:#333;';
const pStyle = 'color:#555;margin:0 0 12px;';
const tableStyle = 'border-collapse:collapse;width:100%;border:1px solid #ddd;font-size:13px;margin-bottom:12px;';
const thStyle = 'text-align:left;background:#f5f5f5;border:1px solid #ddd;padding:8px 10px;font-weight:600;';
const tdStyle = 'border:1px solid #ddd;padding:8px 10px;vertical-align:top;';
const groupRowStyle = 'border:1px solid #ddd;background:#fafafa;padding:6px 10px;font-size:12px;color:#666;font-weight:600;';
const codeStyle = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f5f5f5;padding:1px 4px;border-radius:3px;';
const imgStyle = 'max-width:280px;width:100%;height:auto;border:1px solid #ddd;border-radius:4px;display:block;';

function renderOccurrence(
  occ: { topFrameName: string; parentFrameName: string },
  variableId: string,
  frameDataUrls: Map<string, string>,
  perVarDataUrls: Map<string, Map<string, string>>,
): string {
  const renderOne = (frameName: string, label: string): string => {
    const perVarUrl = perVarDataUrls.get(frameName)?.get(variableId);
    const dataUrl = perVarUrl || frameDataUrls.get(frameName);
    const sub = `<div style="font-size:10px;color:#888;margin-top:2px"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(frameName)}</div>`;
    if (!dataUrl) {
      return `<div style="margin-bottom:6px"><code style="${codeStyle}">frames/${escapeHtml(sanitize(frameName))}.png</code>${sub}</div>`;
    }
    return `<div style="margin-bottom:6px"><img alt="${escapeHtml(frameName)}" src="${dataUrl}" style="${imgStyle}"/>${sub}</div>`;
  };

  // Skip parent if same as top — no benefit to a duplicate image.
  const showParent = occ.parentFrameName && occ.parentFrameName !== occ.topFrameName;
  const parentBlock = showParent ? renderOne(occ.parentFrameName, 'In context') : '';
  const topBlock = renderOne(occ.topFrameName, 'Full frame');
  // Tighter (parent) first, full second.
  return `<div style="border-bottom:1px dashed #eee;padding-bottom:6px;margin-bottom:8px">${parentBlock}${topBlock}</div>`;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  // Build a base64 string in chunks to avoid the call-stack limit on
  // String.fromCharCode(...new Uint8Array(big)).
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  const b64 = btoa(binary);
  return `data:image/png;base64,${b64}`;
}

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
