import type { ExportPayload } from '../types';

// HTML table designed to survive copy-paste into Confluence Cloud.
// All styling inline because Confluence's storage format strips <style> blocks.
//
// Image references are filenames inside the bundle. Confluence won't auto-resolve
// these — the README documents the manual attach + URL-fix step.

export function buildHtml(payload: ExportPayload): string {
  const rows = payload.variables.map((v) => {
    const screenshotLinks = v.frames
      .map((f) => `<code style="${codeStyle}">frames/${sanitize(f)}.png</code>`)
      .join('<br>');

    return `
      <tr>
        <td style="${tdStyle}"><code style="${codeStyle}">${escapeHtml(v.id)}</code></td>
        <td style="${tdStyle}">${escapeHtml(v.value)}</td>
        <td style="${tdStyle}">${escapeHtml(v.description)}</td>
        <td style="${tdStyle}">${escapeHtml(v.frames.join(', '))}</td>
        <td style="${tdStyle}">${screenshotLinks}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(payload.fileName)} — Copy Sync export</title></head>
<body style="${bodyStyle}">
<h2 style="${h2Style}">${escapeHtml(payload.fileName)} — UX copy</h2>
<p style="${pStyle}">Exported ${escapeHtml(payload.exportedAt)} · ${payload.variables.length} string${payload.variables.length === 1 ? '' : 's'} · ${payload.frames.length} frame${payload.frames.length === 1 ? '' : 's'}</p>
<p style="${pStyle}"><strong>To use in Confluence:</strong> select this whole page (⌘A / Ctrl+A), copy, and paste into a Confluence page in edit mode. Then upload the <code>frames/*.png</code> files as page attachments and reference them in the screenshot column.</p>
<table style="${tableStyle}" cellspacing="0" cellpadding="0">
  <thead>
    <tr>
      <th style="${thStyle}">ID</th>
      <th style="${thStyle}">Copy</th>
      <th style="${thStyle}">Description / context</th>
      <th style="${thStyle}">Frames</th>
      <th style="${thStyle}">Screenshots</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

const bodyStyle = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;margin:24px;';
const h2Style = 'font-size:20px;margin:0 0 8px;';
const pStyle = 'color:#555;margin:0 0 12px;';
const tableStyle = 'border-collapse:collapse;width:100%;border:1px solid #ddd;font-size:13px;';
const thStyle = 'text-align:left;background:#f5f5f5;border:1px solid #ddd;padding:8px 10px;font-weight:600;';
const tdStyle = 'border:1px solid #ddd;padding:8px 10px;vertical-align:top;';
const codeStyle = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f5f5f5;padding:1px 4px;border-radius:3px;';

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
