import * as XLSX from 'xlsx';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollectionInfo,
  ExportPayload,
  ImportUpdate,
  PageInfo,
  PluginToUiMessage,
  UiToPluginMessage,
} from './types';
import { buildAndDownloadBundle } from './zip';

function send(msg: UiToPluginMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

type Toast = { level: 'info' | 'error' | 'success'; text: string } | null;

interface ProgressState {
  phase: 'idle' | 'scanning' | 'exporting-frames' | 'building-bundle' | 'done';
  current: number;
  total: number;
  label?: string;
}

type ImportState = 'idle' | 'parsed' | 'applying' | 'results';

interface ImportResult {
  updated: number;
  skippedNames: string[];
  modeErrors: string[];
}

// ---------------------------------------------------------------------------
// XLSX parsing — runs entirely in the UI iframe.
// Reads the "strings" master sheet (or first non-meta sheet) and extracts one
// ImportUpdate per data row. Mode columns are identified as everything
// between the "description" column and the "frames" column.
// ---------------------------------------------------------------------------
function parseImportXlsx(buffer: ArrayBuffer): ImportUpdate[] {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames.includes('strings')
    ? 'strings'
    : wb.SheetNames.find((n) => n !== '_meta') ?? wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as string[][];

  if (!rows.length) throw new Error('Spreadsheet is empty');

  const headers = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
  const idIdx = headers.indexOf('id');
  const descIdx = headers.indexOf('description');
  const framesIdx = headers.indexOf('frames');

  if (idIdx === -1) throw new Error('Missing "id" column — is this a Copy Sync export?');

  const modeStart = descIdx !== -1 ? descIdx + 1 : idIdx + 1;
  const modeEnd = framesIdx !== -1 ? framesIdx : headers.length;
  // Use original (non-lowercased) headers for mode names — must match Figma exactly.
  const origHeaders = rows[0].map((h) => String(h ?? '').trim());
  const modeColumns = origHeaders.slice(modeStart, modeEnd).filter(Boolean);

  if (!modeColumns.length) {
    throw new Error('No mode columns found between "description" and "frames"');
  }

  const updates: ImportUpdate[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const variableName = String(row[idIdx] ?? '').trim();
    if (!variableName) continue;
    const modeValues: Record<string, string> = {};
    for (let c = 0; c < modeColumns.length; c++) {
      modeValues[modeColumns[c]] = String(row[modeStart + c] ?? '');
    }
    updates.push({ variableName, modeValues });
  }

  if (!updates.length) throw new Error('No variable rows found in spreadsheet');
  return updates;
}

function App() {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [exportScale, setExportScale] = useState<1 | 2>(2);
  const [initialised, setInitialised] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', current: 0, total: 0 });
  const [highlightCopy, setHighlightCopy] = useState<boolean>(true);
  // Ref so the message listener (registered once) reads the current toggle value.
  const highlightRef = useRef(highlightCopy);
  useEffect(() => { highlightRef.current = highlightCopy; }, [highlightCopy]);

  const [importState, setImportState] = useState<ImportState>('idle');
  const [importUpdates, setImportUpdates] = useState<ImportUpdate[]>([]);
  const [importParseError, setImportParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  function showToast(level: 'info' | 'error' | 'success', text: string, ms = 4000) {
    setToast({ level, text });
    setTimeout(() => setToast(null), ms);
  }

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data.pluginMessage as PluginToUiMessage | undefined;
      if (!msg) return;

      if (msg.type === 'init') {
        setCollections(msg.collections);
        setPages(msg.pages);

        // Restore collection selection
        const ids = new Set<string>();
        if (msg.persistedSelection && msg.persistedSelection.length) {
          for (const id of msg.persistedSelection) {
            if (msg.collections.some((c) => c.id === id)) ids.add(id);
          }
        } else {
          for (const c of msg.collections) {
            if (c.isCopyByDefault) ids.add(c.id);
          }
        }
        setSelected(ids);

        // Restore page selection — default: all pages selected
        const pageIds = new Set<string>();
        if (msg.persistedPageSelection && msg.persistedPageSelection.length) {
          for (const id of msg.persistedPageSelection) {
            if (msg.pages.some((p) => p.id === id)) pageIds.add(id);
          }
        } else {
          for (const p of msg.pages) pageIds.add(p.id);
        }
        setSelectedPages(pageIds);

        setInitialised(true);
      } else if (msg.type === 'progress') {
        setProgress({ phase: msg.phase, current: msg.current, total: msg.total, label: msg.label });
      } else if (msg.type === 'export-result') {
        const payload = msg.payload;
        const highlight = highlightRef.current;
        setProgress({ phase: 'building-bundle', current: 0, total: 1, label: highlight ? 'Annotating frames…' : 'Building bundle…' });
        buildAndDownloadBundle(payload, { highlight })
          .then(() => {
            setProgress({ phase: 'done', current: 1, total: 1 });
            showToast('success', `Downloaded · ${payload.variables.length} string${payload.variables.length === 1 ? '' : 's'}, ${payload.frames.length} frame${payload.frames.length === 1 ? '' : 's'}`);
          })
          .catch((err: Error) => {
            setProgress({ phase: 'idle', current: 0, total: 0 });
            showToast('error', `Bundle failed: ${String(err.message || err)}`);
          });
      } else if (msg.type === 'toast') {
        showToast(msg.level, msg.text);
        if (msg.level !== 'success') setProgress({ phase: 'idle', current: 0, total: 0 });
      } else if (msg.type === 'import-result') {
        setImportResult({ updated: msg.updated, skippedNames: msg.skippedNames, modeErrors: msg.modeErrors });
        setImportUpdates([]);
        setImportState('results');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const totalSelectedStrings = useMemo(
    () => collections.filter((c) => selected.has(c.id)).reduce((acc, c) => acc + c.stringVariableCount, 0),
    [collections, selected],
  );

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    send({ type: 'persist-selection', selectedCollectionIds: Array.from(next) });
  }

  function togglePage(id: string) {
    const next = new Set(selectedPages);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedPages(next);
    send({ type: 'persist-page-selection', selectedPageIds: Array.from(next) });
  }

  function exportNow() {
    setProgress({ phase: 'scanning', current: 0, total: 0, label: 'Starting…' });
    send({
      type: 'export',
      selectedCollectionIds: Array.from(selected),
      selectedPageIds: Array.from(selectedPages),
      exportScale,
    });
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const updates = parseImportXlsx(reader.result as ArrayBuffer);
        setImportUpdates(updates);
        setImportParseError(null);
        setImportState('parsed');
      } catch (err) {
        setImportParseError(String((err as Error).message || err));
        setImportState('idle');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function applyImport() {
    setImportState('applying');
    send({ type: 'import', updates: importUpdates });
  }

  function cancelImport() {
    setImportState('idle');
    setImportUpdates([]);
    setImportParseError(null);
    setImportResult(null);
  }

  const isWorking = progress.phase === 'scanning' || progress.phase === 'exporting-frames' || progress.phase === 'building-bundle';
  const isImporting = importState === 'applying';
  const importModeNames = importUpdates.length ? Object.keys(importUpdates[0].modeValues) : [];

  // Estimated frame count across selected pages — used for the large-file warning.
  const estimatedFrames = useMemo(
    () => pages.filter((p) => selectedPages.has(p.id)).reduce((acc, p) => acc + p.frameCount, 0),
    [pages, selectedPages],
  );

  // ── Import results panel ──
  if (importState === 'results' && importResult) {
    const { updated, skippedNames, modeErrors } = importResult;
    const hasIssues = skippedNames.length > 0 || modeErrors.length > 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={headerWrap}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Import complete</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            {updated} variable{updated === 1 ? '' : 's'} updated
            {skippedNames.length > 0 ? ` · ${skippedNames.length} not found` : ''}
            {modeErrors.length > 0 ? ` · ${modeErrors.length} mode warning${modeErrors.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
          {/* Not found */}
          {skippedNames.length > 0 && (
            <>
              <div style={resultSectionHeader}>
                Not found in this file ({skippedNames.length})
              </div>
              {skippedNames.map((name) => (
                <div key={name} style={resultRow}>
                  <span style={resultDot('#f90')}>●</span>
                  <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                </div>
              ))}
            </>
          )}

          {/* Mode warnings */}
          {modeErrors.length > 0 && (
            <>
              <div style={{ ...resultSectionHeader, marginTop: skippedNames.length > 0 ? 12 : 0 }}>
                Mode warnings ({modeErrors.length})
              </div>
              {modeErrors.map((msg) => (
                <div key={msg} style={resultRow}>
                  <span style={resultDot('#f90')}>●</span>
                  <span style={{ fontSize: 12 }}>{msg}</span>
                </div>
              ))}
            </>
          )}

          {/* All good */}
          {!hasIssues && (
            <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
              All variables updated successfully.
            </div>
          )}
        </div>

        <div style={footer}>
          <button style={primaryBtn} onClick={cancelImport}>Done</button>
        </div>

        {toast && <div style={{ ...toastStyle, background: toastBg(toast.level) }}>{toast.text}</div>}
      </div>
    );
  }

  // ── Import preview: full-panel view so the variable list can scroll freely ──
  if (importState === 'parsed' || importState === 'applying') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={headerWrap}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Import XLSX</div>
            <button style={refreshBtn} onClick={cancelImport} disabled={isImporting}>Cancel</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            {importUpdates.length} variable{importUpdates.length === 1 ? '' : 's'}
            {importModeNames.length ? ` · modes: ${importModeNames.join(', ')}` : ''}
          </div>
        </div>

        {/* Scrollable list of all variables being imported */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {importUpdates.map((u) => (
            <div key={u.variableName} style={{ ...rowStyle, cursor: 'default' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.variableName}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {Object.entries(u.modeValues).map(([m, v]) => `${m}: "${v}"`).join(' · ')}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={footer}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={secondaryBtn} onClick={cancelImport} disabled={isImporting}>Cancel</button>
            <button style={{ ...primaryBtn, flex: 1 }} onClick={applyImport} disabled={isImporting}>
              {isImporting ? 'Applying…' : `Apply ${importUpdates.length} change${importUpdates.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>

        {toast && <div style={{ ...toastStyle, background: toastBg(toast.level) }}>{toast.text}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header: one compact row ── */}
      <div style={headerWrap}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Select collections containing UX copy strings.
          </div>
          <button
            style={refreshBtn}
            onClick={() => send({ type: 'refresh' })}
            disabled={isWorking || isImporting}
            title="Re-scan variables"
          >Refresh</button>
        </div>
      </div>

      {/* ── Body ── */}
      {!initialised ? (
        <div style={{ padding: 16, color: 'var(--text-secondary)' }}>Loading variables…</div>
      ) : collections.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 12 }}>
          No string variables found. Create a collection (e.g. <code>Copy</code>) with <code>String</code> variables, then refresh.
        </div>
      ) : (
        <>
          {/* Single scrollable body — pages + collections together, no individual caps */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* ── Pages filter ── */}
            {pages.length > 1 && (
              <>
                <div style={sectionLabel}>Pages</div>
                {pages.map((p) => (
                  <label key={p.id} style={{ ...rowStyle, cursor: 'pointer' }}>
                    <input type="checkbox" checked={selectedPages.has(p.id)} onChange={() => togglePage(p.id)} disabled={isWorking || isImporting} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{p.name}</span>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>~{p.frameCount} frame{p.frameCount === 1 ? '' : 's'}</div>
                    </div>
                  </label>
                ))}
              </>
            )}

            {/* ── Collections filter ── */}
            {pages.length > 1 && <div style={sectionLabel}>Collections</div>}
            {collections.map((c) => (
              <label key={c.id} style={{ ...rowStyle, cursor: 'pointer' }}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} disabled={isWorking || isImporting} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    {c.isCopyByDefault && <span style={pill}>auto</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {c.stringVariableCount} string variable{c.stringVariableCount === 1 ? '' : 's'}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {/* ── Footer ── */}
          <div style={footer}>

            {/* Export section */}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {totalSelectedStrings} variable{totalSelectedStrings === 1 ? '' : 's'} selected
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={highlightCopy}
                onChange={(e) => setHighlightCopy(e.target.checked)}
                disabled={isWorking || isImporting}
              />
              <span style={{ fontSize: 12 }}>Highlight copy on screenshots</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={exportScale === 2}
                onChange={(e) => setExportScale(e.target.checked ? 2 : 1)}
                disabled={isWorking || isImporting}
              />
              <span style={{ fontSize: 12 }}>2× screenshots <span style={{ color: 'var(--text-secondary)' }}>(sharper, slower)</span></span>
            </label>

            {estimatedFrames > 20 && !isWorking && (
              <div style={{ fontSize: 11, color: 'var(--warning, #f90)', marginBottom: 8 }}>
                ⚠ ~{estimatedFrames} frames across {pages.filter(p => selectedPages.has(p.id)).length} page{pages.filter(p => selectedPages.has(p.id)).length === 1 ? '' : 's'} — may take a few minutes
              </div>
            )}

            {isWorking && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, marginBottom: 4 }}>
                  {progressLabel(progress)}{progress.label ? ` · ${progress.label}` : ''}
                </div>
                <div style={progressTrack}>
                  <div style={{ ...progressFill, width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '20%' }} />
                </div>
              </div>
            )}

            <button style={primaryBtn} disabled={isWorking || isImporting || totalSelectedStrings === 0} onClick={exportNow}>
              {isWorking ? 'Exporting…' : 'Export bundle'}
            </button>

            {/* Divider between export and import */}
            <div style={divider} />

            {/* Import section */}
            <input
              ref={importFileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleImportFileChange}
            />

            {/* importState is always 'idle' here — parsed/applying handled by early return above */}
            {importParseError && <div style={importErrorBox}>{importParseError}</div>}
            <button
              style={secondaryBtnFull}
              disabled={isWorking}
              onClick={() => importFileRef.current?.click()}
            >
              Import XLSX…
            </button>
          </div>
        </>
      )}

      {toast && <div style={{ ...toastStyle, background: toastBg(toast.level) }}>{toast.text}</div>}
    </div>
  );
}

function progressLabel(p: ProgressState): string {
  switch (p.phase) {
    case 'scanning': return 'Scanning';
    case 'exporting-frames': return `Exporting frame ${p.current}/${p.total}`;
    case 'building-bundle': return 'Building bundle';
    default: return '';
  }
}

function toastBg(level: 'info' | 'error' | 'success'): string {
  if (level === 'error') return 'var(--danger)';
  if (level === 'success') return 'var(--success)';
  return 'var(--bg-secondary)';
}

// ── Styles ──────────────────────────────────────────────────────────────────
const headerWrap: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--border)' };
const sectionLabel: React.CSSProperties = { padding: '6px 12px 2px', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-secondary)', borderTop: '1px solid var(--border)' };
const refreshBtn: React.CSSProperties = { flexShrink: 0, padding: '4px 8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', fontSize: 11 };
const rowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)' };
// Neutral pill — grey so it doesn't visually compete with the blue Export button
const pill: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-secondary)', background: 'var(--border)', padding: '1px 6px', borderRadius: 999 };
const footer: React.CSSProperties = { padding: 12, borderTop: '1px solid var(--border)', background: 'var(--bg)' };
const progressTrack: React.CSSProperties = { height: 4, background: 'var(--bg-secondary)', borderRadius: 999, overflow: 'hidden' };
const progressFill: React.CSSProperties = { height: '100%', background: 'var(--accent, #0d99ff)', transition: 'width 200ms ease' };
const primaryBtn: React.CSSProperties = { width: '100%', padding: '8px 12px', border: '1px solid var(--accent, #0d99ff)', background: 'var(--accent, #0d99ff)', color: 'var(--accent-text, #fff)', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { padding: '7px 12px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', fontSize: 12 };
const secondaryBtnFull: React.CSSProperties = { ...secondaryBtn, width: '100%' };
const divider: React.CSSProperties = { height: 1, background: 'var(--border)', margin: '12px 0' };
const importPreviewBox: React.CSSProperties = { background: 'var(--bg-secondary)', borderRadius: 6, padding: 10 };
const importErrorBox: React.CSSProperties = { borderRadius: 6, padding: '6px 8px', fontSize: 11, color: 'var(--danger, #f33)', marginBottom: 8 };
const resultSectionHeader: React.CSSProperties = { padding: '4px 12px', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-secondary)' };
const resultRow: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 12px', overflow: 'hidden' };
function resultDot(color: string): React.CSSProperties { return { flexShrink: 0, fontSize: 8, color }; }
const toastStyle: React.CSSProperties = { position: 'absolute', bottom: 12, left: 12, right: 12, padding: '8px 10px', borderRadius: 6, color: '#fff', fontSize: 12 };

createRoot(document.getElementById('root')!).render(<App />);
