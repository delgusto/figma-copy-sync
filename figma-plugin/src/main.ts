// Plugin main thread. Reads variables + frames from the file, exports PNGs,
// and ships a single bundle payload to the UI iframe for ZIP packaging.

import type {
  CollectionInfo,
  ExportPayload,
  FramePng,
  PluginToUiMessage,
  UiToPluginMessage,
  VariableEntry,
} from './types';

const PLUGIN_DATA_KEY_SELECTION = 'copyCollections';
const SKIP_PREFIX = '[skip]';

figma.showUI(__html__, { width: 380, height: 560, themeColors: true });

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
  } catch {
    return null;
  }
}

function persistSelection(ids: string[]) {
  figma.root.setPluginData(PLUGIN_DATA_KEY_SELECTION, JSON.stringify(ids));
}

// Initial UI bootstrap.
(async () => {
  const collections = await getCollectionsWithStringVars();
  postToUi({
    type: 'init',
    collections,
    persistedSelection: readPersistedSelection(),
  });
})().catch((err) => {
  postToUi({ type: 'toast', level: 'error', text: `Failed to read variables: ${String(err.message || err)}` });
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

async function buildVariableUsageMap(selectedVarIds: Set<string>): Promise<Map<string, Set<FrameNode>>> {
  const map = new Map<string, Set<FrameNode>>();
  await figma.loadAllPagesAsync();

  for (const page of figma.root.children) {
    if (page.type !== 'PAGE') continue;
    const textNodes = page.findAllWithCriteria({ types: ['TEXT'] });
    for (const node of textNodes) {
      const bound = (node as TextNode).boundVariables;
      if (!bound) continue;
      // boundVariables.characters can be a single VariableAlias or an array.
      const chars = (bound as any).characters;
      if (!chars) continue;
      const aliases = Array.isArray(chars) ? chars : [chars];
      for (const alias of aliases) {
        if (!alias || !alias.id) continue;
        if (!selectedVarIds.has(alias.id)) continue;
        const topFrame = findTopLevelFrame(node);
        if (!topFrame) continue;
        if (!map.has(alias.id)) map.set(alias.id, new Set());
        map.get(alias.id)!.add(topFrame);
      }
    }
  }
  return map;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

async function exportFrames(frames: FrameNode[]): Promise<FramePng[]> {
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

    let base = sanitizeFilename(frame.name) || `frame_${frame.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    let candidate = `${base}.png`;
    let n = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}_${n}.png`;
      n++;
    }
    usedNames.add(candidate);

    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 },
    });
    out.push({
      filename: candidate,
      name: frame.name,
      pageName: (frame.parent && frame.parent.type === 'PAGE') ? frame.parent.name : '',
      bytes,
    });
  }
  return out;
}

async function runExport(selectedCollectionIds: string[]) {
  try {
    if (selectedCollectionIds.length === 0) {
      postToUi({ type: 'toast', level: 'error', text: 'Pick at least one collection to export.' });
      return;
    }

    persistSelection(selectedCollectionIds);

    postToUi({ type: 'progress', phase: 'scanning', current: 0, total: 0, label: 'Reading variables…' });

    // Collect string variables in selected collections.
    const allVars = await figma.variables.getLocalVariablesAsync('STRING');
    const collectionById = new Map<string, VariableCollection>();
    for (const colId of selectedCollectionIds) {
      const col = await figma.variables.getVariableCollectionByIdAsync(colId);
      if (col) collectionById.set(colId, col);
    }
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
    const usage = await buildVariableUsageMap(selectedIds);

    // Build entries.
    const entries: VariableEntry[] = selectedVars.map((v) => {
      const col = collectionById.get(v.variableCollectionId)!;
      const defaultModeId = col.defaultModeId;
      const raw = v.valuesByMode[defaultModeId];
      const value = typeof raw === 'string' ? raw : '';
      const frameSet = usage.get(v.id);
      const frameNames = frameSet
        ? Array.from(frameSet).map((f) => f.name).sort((a, b) => a.localeCompare(b))
        : [];
      return {
        id: v.name,
        name: v.name,
        description: v.description || '',
        collectionName: col.name,
        value,
        frames: Array.from(new Set(frameNames)),
      };
    });

    // Union of all frames across selected variables.
    const allFrames = new Set<FrameNode>();
    for (const set of usage.values()) {
      for (const f of set) allFrames.add(f);
    }
    const framesSorted = Array.from(allFrames).sort((a, b) => a.name.localeCompare(b.name));

    const framePngs = framesSorted.length ? await exportFrames(framesSorted) : [];

    postToUi({ type: 'progress', phase: 'building-bundle', current: 1, total: 1 });

    const payload: ExportPayload = {
      fileName: figma.root.name,
      fileKey: figma.fileKey || '',
      exportedAt: new Date().toISOString(),
      variables: entries,
      frames: framePngs,
    };
    postToUi({ type: 'export-result', payload });
  } catch (err: any) {
    console.error(err);
    postToUi({ type: 'toast', level: 'error', text: `Export failed: ${String(err.message || err)}` });
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
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }
};
