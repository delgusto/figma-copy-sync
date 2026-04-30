// Plugin main thread. Reads variables + frames from the file, exports PNGs,
// and ships a single bundle payload to the UI iframe for ZIP packaging.

import type {
  CollectionInfo,
  CopyRect,
  ExportPayload,
  FramePng,
  PluginToUiMessage,
  UiToPluginMessage,
  VariableEntry,
} from './types';

const EXPORT_SCALE = 2;

const PLUGIN_DATA_KEY_SELECTION = 'copyCollections';
const SKIP_PREFIX = '[skip]';

figma.showUI(__html__, { width: 380, height: 600, themeColors: true });

function postToUi(msg: PluginToUiMessage) {
  figma.ui.postMessage(msg);
}

async function getCollectionsWithStringVars(): Promise<CollectionInfo[]> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const result: CollectionInfo[] = [];
  for (const col of collections) {
    let count = 0;
    for (const varId of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (v && v.resolvedType === 'STRING') count++;
    }
    if (count > 0) {
      result.push({
        id: col.id,
        name: col.name,
        stringVariableCount: count,
        isCopyByDefault: col.name.toLowerCase().startsWith('copy'),
      });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function readPersistedSelection(): string[] | null {
  const raw = figma.root.getPluginData(PLUGIN_DATA_KEY_SELECTION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : null;
  } catch (_e) {
    return null;
  }
}

function persistSelection(ids: string[]) {
  figma.root.setPluginData(PLUGIN_DATA_KEY_SELECTION, JSON.stringify(ids));
}

async function pushInit() {
  try {
    const collections = await getCollectionsWithStringVars();
    postToUi({
      type: 'init',
      collections,
      persistedSelection: readPersistedSelection(),
    });
  } catch (err) {
    postToUi({ type: 'toast', level: 'error', text: `Failed to read variables: ${stringifyError(err)}` });
  }
}

// Initial UI bootstrap.
pushInit();

// Auto-refresh when the document changes — variable add / rename / value edit
// all fire 'documentchange'. Throttle to avoid hammering on rapid edits.
let refreshTimer: number | null = null;
figma.on('documentchange', () => {
  if (refreshTimer != null) return;
  refreshTimer = (setTimeout(() => {
    refreshTimer = null;
    pushInit();
  }, 800) as unknown) as number;
});

function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let cur: BaseNode | null = node;
  while (cur && cur.parent) {
    if (cur.parent.type === 'PAGE') {
      return cur.type === 'FRAME' ? (cur as FrameNode) : null;
    }
    cur = cur.parent;
  }
  return null;
}

interface UsageData {
  /** variableId -> set of top-level frames that contain it */
  varToFrames: Map<string, Set<FrameNode>>;
  /** frameId -> list of [variableId, textNode] pairs in that frame */
  frameToBoundText: Map<string, Array<{ variableId: string; node: TextNode }>>;
}

async function buildVariableUsageMap(
  selectedVarIds: Set<string>,
): Promise<UsageData> {
  const varToFrames = new Map<string, Set<FrameNode>>();
  const frameToBoundText = new Map<string, Array<{ variableId: string; node: TextNode }>>();
  await figma.loadAllPagesAsync();

  for (const page of figma.root.children) {
    if (page.type !== 'PAGE') continue;
    const textNodes = page.findAllWithCriteria({ types: ['TEXT'] });
    for (const node of textNodes) {
      const bound = (node as TextNode).boundVariables;
      if (!bound) continue;
      const chars = (bound as any).characters;
      if (!chars) continue;
      const aliases = Array.isArray(chars) ? chars : [chars];
      for (const alias of aliases) {
        if (!alias || !alias.id) continue;
        if (!selectedVarIds.has(alias.id)) continue;
        const topFrame = findTopLevelFrame(node);
        if (!topFrame) continue;
        if (!varToFrames.has(alias.id)) varToFrames.set(alias.id, new Set());
        varToFrames.get(alias.id)!.add(topFrame);
        if (!frameToBoundText.has(topFrame.id)) frameToBoundText.set(topFrame.id, []);
        frameToBoundText.get(topFrame.id)!.push({ variableId: alias.id, node: node as TextNode });
      }
    }
  }
  return { varToFrames, frameToBoundText };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

async function exportFrames(
  frames: FrameNode[],
  frameToBoundText: Map<string, Array<{ variableId: string; node: TextNode }>>,
  varNameById: Map<string, string>,
): Promise<FramePng[]> {
  const out: FramePng[] = [];
  const usedNames = new Set<string>();
  let i = 0;
  for (const frame of frames) {
    i++;
    postToUi({
      type: 'progress',
      phase: 'exporting-frames',
      current: i,
      total: frames.length,
      label: frame.name,
    });

    const base = sanitizeFilename(frame.name) || `frame_${frame.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    let candidate = `${base}.png`;
    let n = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}_${n}.png`;
      n++;
    }
    usedNames.add(candidate);

    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: EXPORT_SCALE },
    });

    // Compute rects in PNG-pixel coords (relative to frame, scaled).
    const frameBox = frame.absoluteBoundingBox;
    const rects: CopyRect[] = [];
    if (frameBox) {
      const entries = frameToBoundText.get(frame.id) || [];
      for (const { variableId, node } of entries) {
        const nb = node.absoluteBoundingBox;
        if (!nb) continue;
        // Clip to frame bbox so labels can't draw outside the image.
        const x = Math.max(0, nb.x - frameBox.x);
        const y = Math.max(0, nb.y - frameBox.y);
        const right = Math.min(frameBox.width, nb.x + nb.width - frameBox.x);
        const bottom = Math.min(frameBox.height, nb.y + nb.height - frameBox.y);
        const w = Math.max(0, right - x);
        const h = Math.max(0, bottom - y);
        if (w === 0 || h === 0) continue;
        rects.push({
          variableId,
          variableName: varNameById.get(variableId) || variableId,
          x: x * EXPORT_SCALE,
          y: y * EXPORT_SCALE,
          w: w * EXPORT_SCALE,
          h: h * EXPORT_SCALE,
        });
      }
    }

    out.push({
      filename: candidate,
      name: frame.name,
      pageName: (frame.parent && frame.parent.type === 'PAGE') ? frame.parent.name : '',
      bytes,
      width: frameBox ? Math.round(frameBox.width * EXPORT_SCALE) : 0,
      height: frameBox ? Math.round(frameBox.height * EXPORT_SCALE) : 0,
      rects,
    });
  }
  return out;
}

function leafName(fullName: string): string {
  const idx = fullName.lastIndexOf('/');
  return idx === -1 ? fullName : fullName.slice(idx + 1);
}

function groupOf(fullName: string): string {
  const idx = fullName.lastIndexOf('/');
  return idx === -1 ? '' : fullName.slice(0, idx);
}

async function runExport(selectedCollectionIds: string[]) {
  try {
    if (selectedCollectionIds.length === 0) {
      postToUi({ type: 'toast', level: 'error', text: 'Pick at least one collection to export.' });
      return;
    }

    persistSelection(selectedCollectionIds);

    postToUi({ type: 'progress', phase: 'scanning', current: 0, total: 0, label: 'Reading variables…' });

    // Resolve selected collections, in stable order.
    const collectionById = new Map<string, VariableCollection>();
    for (const colId of selectedCollectionIds) {
      const col = await figma.variables.getVariableCollectionByIdAsync(colId);
      if (col) collectionById.set(colId, col);
    }

    // Build ordered union of mode names across selected collections.
    const modeOrder: string[] = [];
    const seenModes = new Set<string>();
    for (const col of collectionById.values()) {
      for (const m of col.modes) {
        if (!seenModes.has(m.name)) {
          seenModes.add(m.name);
          modeOrder.push(m.name);
        }
      }
    }

    const allVars = await figma.variables.getLocalVariablesAsync('STRING');
    const selectedVars = allVars.filter(
      (v) =>
        collectionById.has(v.variableCollectionId) &&
        !v.description.trim().toLowerCase().startsWith(SKIP_PREFIX),
    );

    if (selectedVars.length === 0) {
      postToUi({ type: 'toast', level: 'info', text: 'No copy variables found in the selected collections.' });
      return;
    }

    postToUi({ type: 'progress', phase: 'scanning', current: 0, total: 0, label: 'Mapping variables to frames…' });
    const selectedIds = new Set(selectedVars.map((v) => v.id));
    const varNameById = new Map(selectedVars.map((v) => [v.id, v.name]));
    const usage = await buildVariableUsageMap(selectedIds);

    // Build entries.
    const entries: VariableEntry[] = selectedVars.map((v) => {
      const col = collectionById.get(v.variableCollectionId)!;
      const defaultMode = col.modes.find((m) => m.modeId === col.defaultModeId);
      const values: Record<string, string> = {};
      for (const m of col.modes) {
        const raw = v.valuesByMode[m.modeId];
        values[m.name] = typeof raw === 'string' ? raw : '';
      }
      const frameSet = usage.varToFrames.get(v.id);
      const frameNames = frameSet
        ? Array.from(frameSet).map((f) => f.name).sort((a, b) => a.localeCompare(b))
        : [];
      return {
        id: v.name,
        name: leafName(v.name),
        fullName: v.name,
        group: groupOf(v.name),
        description: v.description || '',
        collectionName: col.name,
        defaultModeName: defaultMode ? defaultMode.name : (col.modes[0] ? col.modes[0].name : ''),
        values,
        frames: Array.from(new Set(frameNames)),
      };
    });

    // Stable sort: collection, then group path, then leaf name.
    entries.sort((a, b) => {
      const c = a.collectionName.localeCompare(b.collectionName);
      if (c !== 0) return c;
      const g = a.group.localeCompare(b.group);
      if (g !== 0) return g;
      return a.name.localeCompare(b.name);
    });

    // Union of all frames across selected variables.
    const allFrames = new Set<FrameNode>();
    for (const set of usage.varToFrames.values()) {
      for (const f of set) allFrames.add(f);
    }
    const framesSorted = Array.from(allFrames).sort((a, b) => a.name.localeCompare(b.name));

    const framePngs = framesSorted.length
      ? await exportFrames(framesSorted, usage.frameToBoundText, varNameById)
      : [];

    postToUi({ type: 'progress', phase: 'building-bundle', current: 1, total: 1 });

    const payload: ExportPayload = {
      fileName: figma.root.name,
      fileKey: figma.fileKey || '',
      exportedAt: new Date().toISOString(),
      modes: modeOrder,
      variables: entries,
      frames: framePngs,
    };
    postToUi({ type: 'export-result', payload });
  } catch (err) {
    console.error(err);
    postToUi({ type: 'toast', level: 'error', text: `Export failed: ${stringifyError(err)}` });
  }
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch (_err) {
    return String(e);
  }
}

figma.ui.onmessage = (msg: UiToPluginMessage) => {
  if (msg.type === 'export') {
    runExport(msg.selectedCollectionIds);
    return;
  }
  if (msg.type === 'persist-selection') {
    persistSelection(msg.selectedCollectionIds);
    return;
  }
  if (msg.type === 'refresh') {
    pushInit();
    return;
  }
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }
};
