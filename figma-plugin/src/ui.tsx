import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import type {
  CollectionInfo,
  ExportPayload,
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

function App() {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialised, setInitialised] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', current: 0, total: 0 });
  const [lastResult, setLastResult] = useState<ExportPayload | null>(null);

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
        setProgress({ phase: 'done', current: 1, total: 1 });
        setLastResult(msg.payload);
        buildAndDownloadBundle(msg.payload)
          .then(() => {
            setToast({
              level: 'success',
              text: `Bundle downloaded · ${msg.payload.variables.length} string${msg.payload.variables.length === 1 ? '' : 's'}, ${msg.payload.frames.length} frame${msg.payload.frames.length === 1 ? '' : 's'}`,
            });
            setTimeout(() => setToast(null), 4000);
          })
          .catch((err) => {
            setToast({ level: 'error', text: `Bundle build failed: ${String(err.message || err)}` });
          });
      } else if (msg.type === 'toast') {
        setToast({ level: msg.level, text: msg.text });
        setTimeout(() => setToast(null), 3500);
        if (msg.level === 'error' || msg.level === 'info') setProgress({ phase: 'idle', current: 0, total: 0 });
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

  const isWorking = progress.phase === 'scanning' || progress.phase === 'exporting-frames' || progress.phase === 'building-bundle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={headerWrap}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Copy Sync — Export</div>
          <button
            style={refreshBtn}
            onClick={() => send({ type: 'refresh' })}
            disabled={isWorking}
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
                  <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} disabled={isWorking} />
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
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {totalSelectedStrings} variable{totalSelectedStrings === 1 ? '' : 's'} selected
            </div>

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

            <button style={primaryBtn} disabled={isWorking || totalSelectedStrings === 0} onClick={exportNow}>
              {isWorking ? 'Exporting…' : 'Export bundle'}
            </button>

            {lastResult && progress.phase === 'done' && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8 }}>
                Last: {lastResult.variables.length} string{lastResult.variables.length === 1 ? '' : 's'}, {lastResult.frames.length} frame{lastResult.frames.length === 1 ? '' : 's'}.
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
const toastStyle: React.CSSProperties = { position: 'absolute', bottom: 12, left: 12, right: 12, padding: '8px 10px', borderRadius: 6, color: '#fff', fontSize: 12 };

createRoot(document.getElementById('root')!).render(<App />);
