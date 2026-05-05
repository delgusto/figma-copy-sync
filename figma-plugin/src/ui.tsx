import * as XLSX from 'xlsx';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollectionInfo,
  ExportPayload,
  ImportUpdate,
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

type ImportState = 'idle' | 'parsed' | 'applying';

// ---------------------------------------------------------------------------
// XLSX parsing — runs entirely in the UI iframe.
// Reads the "strings" master sheet (or first sheet) and extracts one
// ImportUpdate per data row. Mode columns are identified as everything
// between the "description" column and the "frames" column.
// ---------------------------------------------------------------------------
function parseImportXlsx(buffer: ArrayBuffer): ImportUpdate[] {
  const wb = XLSX.read(buffer, { type: 'array' });

  // Prefer the "strings" master sheet; fall back to first sheet.
  // Skip "_meta" and per-collection sheets.
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

  // Mode columns sit between "description" (exclusive) and "frames" (exclusive).
  // If "description" is missing, start immediately after "id".
  const modeStart = descIdx !== -1 ? descIdx + 1 : idIdx + 1;
  const modeEnd = framesIdx !== -1 ? framesIdx : headers.length;
  // Use original (non-lowercased) header row for mode names — they must match Figma exactly.
  const origHeaders = rows[0].map((h) => String(h ?? '').trim());
  const modeColumns = origHeaders.slice(modeStart, modeEnd).filter(Boolean);

  if (!modeColumns.length) {
    throw new Error('No mode columns found — expected columns between "description" and "frames"');
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
  const [initialised, setInitialised] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', current: 0, total: 0 });
  const [lastResult, setLastResult] = useState<ExportPayload | null>(null);
  const [highlightCopy, setHighlightCopy] = useState<boolean>(true);
  // Ref so the message listener (registered once) reads the current toggle.
  const highlightRef = useRef(highlightCopy);
  useEffect(() => { highlightRef.current = highlightCopy; }, [highlightCopy]);

  // Import state
  const [importState, setImportState] = useState<ImportState>('idle');
  const [importUpdates, setImportUpdates] = useState<ImportUpdate[]>([]);
  const [importParseError, setImportParseError] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  function showToast(level: 'info' | 'error' | 'success', text: string, durationMs = 4000) {
    setToast({ level, text });
    setTimeout(() => setToast(null), durationMs);
  }

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data.pluginMessage as PluginToUiMessage | undefined;
      if (!msg) return;

      if (msg.type === 'init') {
        setCollections(msg.collections);
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
        setInitialised(true);
      } else if (msg.type === 'progress') {
        setProgress({ phase: msg.phase, current: msg.current, total: msg.total, label: msg.label });
      } else if (msg.type === 'export-result') {
        const payload = msg.payload;
        const highlight = highlightRef.current;
        setProgress({
          phase: 'building-bundle',
          current: 0,
          total: 1,
          label: highlight ? 'Annotating frames…' : 'Building bundle…',
        });
        setLastResult(payload);
        buildAndDownloadBundle(payload, { highlight })
          .then(() => {
            setProgress({ phase: 'done', current: 1, total: 1 });
            showToast(
              'success',
              `Bundle downloaded · ${payload.variables.length} string${payload.variables.length === 1 ? '' : 's'}, ${payload.frames.length} frame${payload.frames.length === 1 ? '' : 's'}`,
            );
          })
          .catch((err) => {
            setProgress({ phase: 'idle', current: 0, total: 0 });
            showToast('error', `Bundle build failed: ${String(err.message || err)}`);
          });
      } else if (msg.type === 'toast') {
        showToast(msg.level, msg.text, 4000);
        if (msg.level === 'error' || msg.level === 'info') setProgress({ phase: 'idle', current: 0, total: 0 });
      } else if (msg.type === 'import-result') {
        // Reset import UI — toast already shown by main thread.
        setImportState('idle');
        setImportUpdates([]);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const totalSelectedStrings = useMemo(() => {
    return collections.filter((c) => selected.has(c.id)).reduce((acc, c) => acc + c.stringVariableCount, 0);
  }, [collections, selected]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    send({ type: 'persist-selection', selectedCollectionIds: Array.from(next) });
  }

  function exportNow() {
    setLastResult(null);
    setProgress({ phase: 'scanning', current: 0, total: 0, label: 'Starting…' });
    send({ type: 'export', selectedCollectionIds: Array.from(selected) });
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset input immediately so the same file can be re-selected after cancel.
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
  }

  const isWorking = progress.phase === 'scanning' || progress.phase === 'exporting-frames' || progress.phase === 'building-bundle';
  const isImporting = importState === 'applying';

  // Derive a compact summary of what will be imported.
  const importModeNames = importUpdates.length
    ? Object.keys(importUpdates[0].modeValues)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={headerWrap}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Copy Sync</div>
          <button
            style={refreshBtn}
            onClick={() => send({ type: 'refresh' })}
            disabled={isWorking || isImporting}
            title="Re-scan variables in this file"
          >Refresh</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          Pick the collections that hold UX copy. Description column comes from each variable's <em>description</em> in Figma's variable panel.
        </div>
      </div>

      {!initialised ? (
        <div style={{ padding: 16, color: 'var(--text-secondary)' }}>Loading variables…</div>
      ) : collections.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
          No string variables found in this file. Create a variable collection (e.g. <code>Copy</code>) and add some <code>String</code> variables, then re-run.
        </div>
      ) : (
        <>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {collections.map((c) => {
              const checked = selected.has(c.id);
              return (
                <label key={c.id} style={{ ...rowStyle, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} disabled={isWorking || isImporting} />
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
              );
            })}
          </div>

          <div style={footer}>
            {/* ── Export section ── */}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {totalSelectedStrings} variable{totalSelectedStrings === 1 ? '' : 's'} selected
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={highlightCopy}
                onChange={(e) => setHighlightCopy(e.target.checked)}
                disabled={isWorking || isImporting}
              />
              <span style={{ fontSize: 12 }}>Highlight copy on screenshots</span>
            </label>

            {isWorking && (
              <div style={progressBox}>
                <div style={{ fontSize: 11, marginBottom: 4 }}>
                  {progressLabel(progress)}{progress.label ? ` · ${progress.label}` : ''}
                </div>
                <div style={progressTrack}>
                  <div style={{ ...progressFill, width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '20%' }} />
                </div>
              </div>
            )}

            <button
              style={primaryBtn}
              disabled={isWorking || isImporting || totalSelectedStrings === 0}
              onClick={exportNow}
            >
              {isWorking ? 'Exporting…' : 'Export bundle'}
            </button>

            {lastResult && progress.phase === 'done' && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8 }}>
                Last: {lastResult.variables.length} string{lastResult.variables.length === 1 ? '' : 's'}, {lastResult.frames.length} frame{lastResult.frames.length === 1 ? '' : 's'}.
              </div>
            )}

            {/* ── Divider ── */}
            <div style={divider} />

            {/* ── Import section ── */}
            {importState === 'idle' && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Import an exported <code>strings.xlsx</code> to push edited copy back into Figma variables.
                </div>
                {importParseError && (
                  <div style={importErrorBox}>{importParseError}</div>
                )}
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  style={{ display: 'none' }}
                  onChange={handleImportFileChange}
                />
                <button
                  style={secondaryBtn}
                  disabled={isWorking || isImporting}
                  onClick={() => importFileRef.current?.click()}
                >
                  Import XLSX…
                </button>
              </>
            )}

            {importState === 'parsed' && (
              <div style={importPreviewBox}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  {importUpdates.length} variable{importUpdates.length === 1 ? '' : 's'} to update
                  {importModeNames.length ? ` · ${importModeNames.join(', ')}` : ''}
                </div>
                {/* Show first 4 variable names as a preview */}
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {importUpdates.slice(0, 4).map((u) => (
                    <div key={u.variableName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {u.variableName}
                    </div>
                  ))}
                  {importUpdates.length > 4 && (
                    <div style={{ color: 'var(--text-tertiary, #aaa)' }}>…and {importUpdates.length - 4} more</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={secondaryBtn} onClick={cancelImport}>Cancel</button>
                  <button style={{ ...primaryBtn, flex: 1 }} onClick={applyImport}>
                    Apply {importUpdates.length} change{importUpdates.length === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            )}

            {importState === 'applying' && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 0' }}>
                Applying changes…
              </div>
            )}
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

const headerWrap: React.CSSProperties = { padding: 12, borderBottom: '1px solid var(--border)' };
const refreshBtn: React.CSSProperties = { padding: '4px 8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', fontSize: 11 };
const rowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)' };
const pill: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--accent-text, #fff)', background: 'var(--accent, #0d99ff)', padding: '1px 6px', borderRadius: 999 };
const footer: React.CSSProperties = { padding: 12, borderTop: '1px solid var(--border)', background: 'var(--bg)' };
const progressBox: React.CSSProperties = { marginBottom: 10 };
const progressTrack: React.CSSProperties = { height: 4, background: 'var(--bg-secondary)', borderRadius: 999, overflow: 'hidden' };
const progressFill: React.CSSProperties = { height: '100%', background: 'var(--accent, #0d99ff)', transition: 'width 200ms ease' };
const primaryBtn: React.CSSProperties = { width: '100%', padding: '8px 12px', border: '1px solid var(--accent, #0d99ff)', background: 'var(--accent, #0d99ff)', color: 'var(--accent-text, #fff)', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { padding: '7px 12px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', fontSize: 12 };
const divider: React.CSSProperties = { height: 1, background: 'var(--border)', margin: '12px 0' };
const importPreviewBox: React.CSSProperties = { background: 'var(--bg-secondary)', borderRadius: 6, padding: 10, marginTop: 0 };
const importErrorBox: React.CSSProperties = { background: 'var(--danger-subtle, #fff0f0)', border: '1px solid var(--danger, #f55)', borderRadius: 6, padding: '6px 8px', fontSize: 11, color: 'var(--danger, #c00)', marginBottom: 8 };
const toastStyle: React.CSSProperties = { position: 'absolute', bottom: 12, left: 12, right: 12, padding: '8px 10px', borderRadius: 6, color: '#fff', fontSize: 12 };

createRoot(document.getElementById('root')!).render(<App />);
