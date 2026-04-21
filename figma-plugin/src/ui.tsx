import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import type {
  CopyString,
  Project,
  PluginToUiMessage,
  SelectionInfo,
  UiToPluginMessage,
} from './types';

const MOCK_SERVER = 'http://localhost:3737';

function send(msg: UiToPluginMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

async function fetchProject(projectId: string): Promise<Project> {
  const res = await fetch(`${MOCK_SERVER}/projects/${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

async function fetchProjectList(): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${MOCK_SERVER}/projects`);
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

type Toast = { level: 'info' | 'error' | 'success'; text: string } | null;

function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [selection, setSelection] = useState<SelectionInfo[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Listen for messages from plugin main thread.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data.pluginMessage as PluginToUiMessage | undefined;
      if (!msg) return;
      if (msg.type === 'init') {
        setProjectId(msg.projectId);
        setSelection(msg.selection);
      } else if (msg.type === 'selection-change') {
        setSelection(msg.selection);
      } else if (msg.type === 'toast') {
        setToast({ level: msg.level, text: msg.text });
        setTimeout(() => setToast(null), 2400);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Load available projects once, for the bind flow.
  useEffect(() => {
    fetchProjectList()
      .then(setProjects)
      .catch((err) => setServerError(String(err.message || err)));
  }, []);

  // Load project strings whenever bound projectId changes.
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetchProject(projectId)
      .then((p) => {
        setProject(p);
        setServerError(null);
      })
      .catch((err) => setServerError(String(err.message || err)))
      .finally(() => setLoading(false));
  }, [projectId]);

  const strings = project?.strings ?? [];
  const filteredStrings = useMemo(() => {
    if (!filter.trim()) return strings;
    const q = filter.toLowerCase();
    return strings.filter(
      (s) => s.id.toLowerCase().includes(q) || s.en.toLowerCase().includes(q),
    );
  }, [strings, filter]);

  const selectedNode = selection[0] ?? null;

  function bindFileToProject(id: string) {
    send({ type: 'bind-file-to-project', projectId: id });
  }

  function bindSelectionToString(stringId: string) {
    if (!selectedNode) return;
    send({ type: 'bind-layer', nodeId: selectedNode.id, stringId });
  }

  function unbindSelection() {
    if (!selectedNode) return;
    send({ type: 'unbind-layer', nodeId: selectedNode.id });
  }

  async function refresh(scope: 'selection' | 'page') {
    if (!projectId) return;
    try {
      const fresh = await fetchProject(projectId);
      setProject(fresh);
      send({
        type: scope === 'selection' ? 'refresh-selection' : 'refresh-page',
        strings: fresh.strings,
      });
    } catch (err: any) {
      setServerError(String(err.message || err));
    }
  }

  if (!projectId) {
    return (
      <Shell toast={toast}>
        <Header title="Bind file to a project" />
        <div style={{ padding: 12 }}>
          <p style={muted}>Pick which project's copy this Figma file uses. Locks the file to that namespace.</p>
          {serverError && <ErrorBanner msg={serverError} />}
          {projects.length === 0 && !serverError && <p style={muted}>Loading…</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            {projects.map((p) => (
              <button key={p.id} style={primaryBtn} onClick={() => bindFileToProject(p.id)}>
                {p.name} <span style={{ opacity: 0.6, marginLeft: 6 }}>({p.id})</span>
              </button>
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell toast={toast}>
      <Header
        title={project?.name ?? projectId}
        subtitle={`${strings.length} string${strings.length === 1 ? '' : 's'} · project: ${projectId}`}
      />

      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <button style={primaryBtn} onClick={() => refresh('selection')} disabled={loading}>
          Refresh selection
        </button>
        <button style={secondaryBtn} onClick={() => refresh('page')} disabled={loading}>
          Refresh page
        </button>
      </div>

      <SelectionPanel selection={selection} onUnbind={unbindSelection} />

      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <input
          style={input}
          placeholder={selectedNode && selectedNode.type === 'TEXT' ? 'Bind text layer — filter by ID or copy' : 'Select a text layer to bind'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={!selectedNode || selectedNode.type !== 'TEXT'}
        />
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {serverError && <ErrorBanner msg={serverError} />}
        {filteredStrings.map((s) => (
          <StringRow
            key={s.id}
            s={s}
            canBind={!!selectedNode && selectedNode.type === 'TEXT'}
            isBoundToSelection={selectedNode?.boundStringId === s.id}
            onBind={() => bindSelectionToString(s.id)}
          />
        ))}
        {!filteredStrings.length && !loading && (
          <div style={{ padding: 16, color: 'var(--text-secondary)' }}>No matching strings.</div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children, toast }: { children: React.ReactNode; toast: Toast }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {children}
      {toast && (
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            right: 12,
            padding: '8px 10px',
            borderRadius: 6,
            background:
              toast.level === 'error'
                ? 'var(--danger)'
                : toast.level === 'success'
                ? 'var(--success)'
                : 'var(--bg-secondary)',
            color: toast.level === 'info' ? 'var(--text)' : '#fff',
            fontSize: 12,
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function SelectionPanel({ selection, onUnbind }: { selection: SelectionInfo[]; onUnbind: () => void }) {
  if (!selection.length) {
    return (
      <div style={{ padding: '8px 12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
        No selection.
      </div>
    );
  }
  const first = selection[0];
  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{first.type}</div>
      <div style={{ fontWeight: 500 }}>{first.name || '(unnamed)'}</div>
      {first.boundStringId ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <code style={{ fontSize: 11 }}>{first.boundStringId}</code>
          <button style={linkBtn} onClick={onUnbind}>unbind</button>
        </div>
      ) : first.type === 'TEXT' ? (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Unbound. Pick an ID below.</div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Select a text layer to bind.</div>
      )}
    </div>
  );
}

function StringRow({
  s,
  canBind,
  isBoundToSelection,
  onBind,
}: {
  s: CopyString;
  canBind: boolean;
  isBoundToSelection: boolean;
  onBind: () => void;
}) {
  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: isBoundToSelection ? 'var(--bg-secondary)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.id}</code>
        <StatusPill status={s.status} />
      </div>
      <div style={{ marginTop: 2 }}>{s.en}</div>
      {canBind && (
        <button style={{ ...linkBtn, marginTop: 4 }} onClick={onBind} disabled={isBoundToSelection}>
          {isBoundToSelection ? 'bound' : 'bind to selection'}
        </button>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: CopyString['status'] }) {
  const color =
    status === 'approved' || status === 'live'
      ? 'var(--success)'
      : status === 'review'
      ? 'var(--accent)'
      : 'var(--text-secondary)';
  return (
    <span style={{ fontSize: 10, color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{status}</span>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div style={{ margin: 12, padding: 10, borderRadius: 6, background: 'var(--danger)', color: '#fff', fontSize: 11 }}>
      Server error: {msg}. Is the mock server running? Try <code>npm run server</code>.
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--accent-text)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
};

const secondaryBtn: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
};

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--accent)',
  cursor: 'pointer',
  fontSize: 11,
  textDecoration: 'underline',
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  background: 'var(--bg)',
  color: 'var(--text)',
};

const muted: React.CSSProperties = { color: 'var(--text-secondary)', margin: 0 };

createRoot(document.getElementById('root')!).render(<App />);
