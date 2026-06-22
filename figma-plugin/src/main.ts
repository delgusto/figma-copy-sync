// Plugin main thread. Reads variables + frames from the file, exports PNGs,
// and ships a single bundle payload to the UI iframe for ZIP packaging.

import type {
  CollectionInfo,
  CopyRect,
  ExportPayload,
  FramePng,
  ImportUpdate,
  PageInfo,
  PluginToUiMessage,
  TeamSettings,
  UiToPluginMessage,
  VariableEntry,
} from './types';

const PLUGIN_DATA_KEY_SELECTION = 'copyCollections';
const PLUGIN_DATA_KEY_PAGES = 'copyPages';
// Team templates are a per-user setting (shared across files) → clientStorage.
const CLIENT_STORAGE_KEY_TEAM = 'copyTeamSettings';
const SKIP_PREFIX = '[skip]';

const EMPTY_TEAM_SETTINGS: TeamSettings = { templates: [], defaultTemplateId: null };

async function loadTeamSettings(): Promise<void> {
  let settings = EMPTY_TEAM_SETTINGS;
  try {
    const raw = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEY_TEAM);
    if (raw && typeof raw === 'object' && Array.isArray((raw as TeamSettings).templates)) {
      settings = raw as TeamSettings;
    }
  } catch {
    // Fall back to empty settings if storage is unreadable.
  }
  postToUi({ type: 'team-settings', settings });
}

async function saveTeamSettings(settings: TeamSettings): Promise<void> {
  try {
    await figma.clientStorage.setAsync(CLIENT_STORAGE_KEY_TEAM, settings);
  } catch {
    postToUi({ type: 'toast', level: 'error', text: 'Could not save team settings' });
  }
}

figma.showUI(__html__, { width: 400, height: 700, themeColors: true });

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

function readPersistedPageSelection(): string[] | null {
  const raw = figma.root.getPluginData(PLUGIN_DATA_KEY_PAGES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : null;
  } catch (_e) {
    return null;
  }
}

function persistPageSelection(ids: string[]) {
  figma.root.setPluginData(PLUGIN_DATA_KEY_PAGES, JSON.stringify(ids));
}

function getPageInfos(): PageInfo[] {
  // Synchronous — no loadAllPagesAsync needed. page.children is available
  // before the page content is loaded (returns top-level children only).
  // Count exportable top-level nodes (FRAME, COMPONENT, COMPONENT_SET, INSTANCE)
  // since the plugin treats all four as "frames" for export purposes.
  return figma.root.children
    .filter((n) => n.type === 'PAGE')
    .map((p) => ({
      id: p.id,
      name: p.name,
      frameCount: (p as PageNode).children.filter(
        (c) => c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'COMPONENT_SET' || c.type === 'INSTANCE',
      ).length,
    }));
}

async function pushInit() {
  try {
    const collections = await getCollectionsWithStringVars();
    const pages = getPageInfos();
    postToUi({
      type: 'init',
      collections,
      pages,
      persistedSelection: readPersistedSelection(),
      persistedPageSelection: readPersistedPageSelection(),
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

// Returns the topmost exportable node on a page that contains `node`.
// Accepts FRAME, COMPONENT, COMPONENT_SET, and INSTANCE — all support
// exportAsync and absoluteBoundingBox, so any can be exported as PNG.
// Previously only accepted FRAME, which silently dropped bindings inside
// component instances placed directly on the canvas.
function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let cur: BaseNode | null = node;
  while (cur && cur.parent) {
    if (cur.parent.type === 'PAGE') {
      return (
        cur.type === 'FRAME' ||
        cur.type === 'COMPONENT' ||
        cur.type === 'COMPONENT_SET' ||
        cur.type === 'INSTANCE'
      ) ? (cur as FrameNode) : null;
    }
    cur = cur.parent;
  }
  return null;
}

interface Binding {
  variableId: string;
  node: TextNode;
  topFrame: FrameNode;
  parentFrame: FrameNode; // nearest ancestor frame; equals topFrame when text sits directly inside top-level
}

function findNearestParentFrame(node: BaseNode): FrameNode | null {
  // Walk up to find a useful "in context" frame for this node.
  //
  // Preference: if the node is inside a component INSTANCE, use the closest
  // INSTANCE ancestor (i.e. the whole card / component, not its library
  // internals). Inner frames inside a library instance often have transparent
  // backgrounds or weird crops that produce confusing "in context" screenshots.
  //
  // If there's no instance ancestor, fall back to the nearest FRAME / COMPONENT.
  let cur: BaseNode | null = node.parent;
  let closestInstance: FrameNode | null = null;
  while (cur) {
    if (cur.type === 'PAGE') break;
    if (cur.type === 'INSTANCE' && !closestInstance) {
      closestInstance = cur as unknown as FrameNode;
    }
    cur = cur.parent;
  }
  if (closestInstance) return closestInstance;

  cur = node.parent;
  while (cur) {
    if (cur.type === 'PAGE') return null;
    if (cur.type === 'FRAME' || cur.type === 'COMPONENT' || cur.type === 'COMPONENT_SET') {
      return cur as FrameNode;
    }
    cur = cur.parent;
  }
  return null;
}

async function buildBindings(selectedVarIds: Set<string>, selectedPageIds: Set<string>): Promise<Binding[]> {
  const bindings: Binding[] = [];
  // De-dupe by (variableId + nodeId) so direct-binding and component-property
  // scans don't produce duplicate rects for the same text node.
  const seen = new Set<string>();

  function pushBinding(variableId: string, node: TextNode, topFrame: FrameNode, parentFrame: FrameNode) {
    const key = `${variableId}::${node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    bindings.push({ variableId, node, topFrame, parentFrame });
  }

  const pages = figma.root.children.filter(
    (n) => n.type === 'PAGE' && selectedPageIds.has(n.id),
  ) as PageNode[];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    postToUi({
      type: 'progress',
      phase: 'scanning',
      current: i + 1,
      total: pages.length,
      label: `Scanning "${page.name}"…`,
    });
    // Load only this page's content — avoids loading the whole file.
    await page.loadAsync();

    // ── Pass 1: direct boundVariables.characters on text nodes ──────────────
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
        const parent = findNearestParentFrame(node);
        pushBinding(alias.id, node as TextNode, topFrame, parent || topFrame);
      }
    }

    // ── Pass 2: component text properties bound to variables ─────────────────
    // Handles the case where a text layer inside a library component instance
    // has its content driven by a component text property (visible in the
    // instance properties panel), and that property is bound to a local variable.
    // In this case boundVariables.characters on the text node points to the
    // component property key, not the variable — Pass 1 misses it.
    const instances = page.findAllWithCriteria({ types: ['INSTANCE'] });
    for (const instance of instances) {
      const props = (instance as InstanceNode).componentProperties;
      if (!props) continue;
      for (const [propKey, prop] of Object.entries(props)) {
        if (prop.type !== 'TEXT') continue;
        const varAlias = (prop as any).boundVariables?.value;
        if (!varAlias?.id || !selectedVarIds.has(varAlias.id)) continue;
        // Find the specific text node inside this instance that this property drives.
        // componentPropertyReferences.characters === propKey identifies it.
        const innerText = (instance as InstanceNode).findAllWithCriteria({ types: ['TEXT'] });
        for (const textNode of innerText) {
          const refs = (textNode as TextNode).componentPropertyReferences;
          if (!refs || refs.characters !== propKey) continue;
          const topFrame = findTopLevelFrame(textNode);
          if (!topFrame) continue;
          const parent = findNearestParentFrame(textNode);
          pushBinding(varAlias.id, textNode as TextNode, topFrame, parent || topFrame);
        }
      }
    }

    // ── Pass 3: inherited bindings from the main component ───────────────────
    // When a variable is bound to a text layer in the MAIN COMPONENT (not
    // overridden per-instance), the instance's text nodes may not expose
    // boundVariables.characters (Pass 1 misses it) and may not be exposed via
    // componentProperties (Pass 2 misses it). Resolve the main component and
    // check its text nodes directly, then match to the instance's text nodes
    // by layer name for rect accuracy (falls back to the instance bbox).
    for (const instance of instances) {
      let mainComp: ComponentNode | null = null;
      try {
        mainComp = await (instance as InstanceNode).getMainComponentAsync();
      } catch (_e) {
        continue;
      }
      if (!mainComp) continue;

      const compTextNodes = mainComp.findAllWithCriteria({ types: ['TEXT'] });
      for (const compNode of compTextNodes) {
        const bound = (compNode as TextNode).boundVariables;
        if (!bound) continue;
        const chars = (bound as any).characters;
        if (!chars) continue;
        const aliases = Array.isArray(chars) ? chars : [chars];
        for (const alias of aliases) {
          if (!alias?.id || !selectedVarIds.has(alias.id)) continue;
          // Find the matching text node inside the instance (by layer name).
          const instanceTextNodes = (instance as InstanceNode).findAllWithCriteria({ types: ['TEXT'] });
          const match = instanceTextNodes.find((t) => t.name === compNode.name) as TextNode | undefined;
          const targetNode = (match || instance) as unknown as TextNode;
          const topFrame = findTopLevelFrame(targetNode as unknown as BaseNode);
          if (!topFrame) continue;
          const parent = findNearestParentFrame(targetNode as unknown as BaseNode);
          pushBinding(alias.id, targetNode, topFrame, parent || topFrame);
        }
      }
    }
  }
  return bindings;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

/**
 * Export each frame in the given set, computing rects relative to that frame
 * for every binding whose top-frame OR parent-frame matches.
 *
 * Frame names can collide; the returned PNG `name` is suffixed with the page
 * name when the same frame name appears on multiple pages, so HTML lookups
 * stay unambiguous. The internal `id` is the source of truth for matching.
 */
async function exportFrames(
  frames: FrameNode[],
  bindings: Binding[],
  varNameById: Map<string, string>,
  exportScale: 1 | 2,
): Promise<{ pngs: FramePng[]; nameByFrameId: Map<string, string> }> {
  // Display-name uniqueness. Two passes:
  //   1. If the raw name collides at all, suffix with the page name.
  //   2. If still colliding (two frames with the same name on the same
  //      page — common in design systems with reused component names),
  //      append "#2", "#3", … so each frame's display name is unique.
  // Uniqueness is required because the HTML/CSS pipeline caches annotated
  // images by display name; collisions cause one row to render another
  // row's screenshot (no red box around the current variable's text).
  const nameCounts = new Map<string, number>();
  for (const f of frames) nameCounts.set(f.name, (nameCounts.get(f.name) || 0) + 1);
  const nameByFrameId = new Map<string, string>();
  const usedDisplay = new Set<string>();
  for (const f of frames) {
    const collide = (nameCounts.get(f.name) || 0) > 1;
    const pageName = (f.parent && f.parent.type === 'PAGE') ? f.parent.name : '';
    const base = collide && pageName ? `${f.name} (${pageName})` : f.name;
    let candidate = base;
    let n = 2;
    while (usedDisplay.has(candidate)) {
      candidate = `${base} #${n}`;
      n++;
    }
    usedDisplay.add(candidate);
    nameByFrameId.set(f.id, candidate);
  }

  const out: FramePng[] = [];
  const usedFilenames = new Set<string>();
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

    const baseFilename = sanitizeFilename(frame.name) || `frame_${frame.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    let candidate = `${baseFilename}.png`;
    let n = 2;
    while (usedFilenames.has(candidate)) {
      candidate = `${baseFilename}_${n}.png`;
      n++;
    }
    usedFilenames.add(candidate);

    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: exportScale },
    });

    const frameBox = frame.absoluteBoundingBox;
    const rects: CopyRect[] = [];
    if (frameBox) {
      // Pull every binding whose top OR parent frame is THIS frame.
      // Compute rect coordinates relative to THIS frame's origin (regardless
      // of whether the binding's role for this frame is "top" or "parent").
      for (const b of bindings) {
        if (b.topFrame.id !== frame.id && b.parentFrame.id !== frame.id) continue;
        const nb = b.node.absoluteBoundingBox;
        if (!nb) continue;
        const x = Math.max(0, nb.x - frameBox.x);
        const y = Math.max(0, nb.y - frameBox.y);
        const right = Math.min(frameBox.width, nb.x + nb.width - frameBox.x);
        const bottom = Math.min(frameBox.height, nb.y + nb.height - frameBox.y);
        const w = Math.max(0, right - x);
        const h = Math.max(0, bottom - y);
        if (w === 0 || h === 0) continue;
        rects.push({
          variableId: b.variableId,
          variableName: varNameById.get(b.variableId) || b.variableId,
          x: x * exportScale,
          y: y * exportScale,
          w: w * exportScale,
          h: h * exportScale,
        });
      }
    }

    out.push({
      filename: candidate,
      name: nameByFrameId.get(frame.id) || frame.name,
      pageName: (frame.parent && frame.parent.type === 'PAGE') ? frame.parent.name : '',
      bytes,
      width: frameBox ? Math.round(frameBox.width * exportScale) : 0,
      height: frameBox ? Math.round(frameBox.height * exportScale) : 0,
      rects,
    });
  }
  return { pngs: out, nameByFrameId };
}

function leafName(fullName: string): string {
  const idx = fullName.lastIndexOf('/');
  return idx === -1 ? fullName : fullName.slice(idx + 1);
}

function groupOf(fullName: string): string {
  const idx = fullName.lastIndexOf('/');
  return idx === -1 ? '' : fullName.slice(0, idx);
}

async function runExport(selectedCollectionIds: string[], selectedPageIds: string[], exportScale: 1 | 2) {
  try {
    if (selectedCollectionIds.length === 0) {
      postToUi({ type: 'toast', level: 'error', text: 'Pick at least one collection to export.' });
      return;
    }
    if (selectedPageIds.length === 0) {
      postToUi({ type: 'toast', level: 'error', text: 'Pick at least one page to export.' });
      return;
    }

    persistSelection(selectedCollectionIds);
    persistPageSelection(selectedPageIds);

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

    const selectedIds = new Set(selectedVars.map((v) => v.id));
    const varNameById = new Map(selectedVars.map((v) => [v.id, v.name]));
    const bindings = await buildBindings(selectedIds, new Set(selectedPageIds));

    // Group bindings by variable id for entry construction.
    const bindingsByVar = new Map<string, Binding[]>();
    for (const b of bindings) {
      if (!bindingsByVar.has(b.variableId)) bindingsByVar.set(b.variableId, []);
      bindingsByVar.get(b.variableId)!.push(b);
    }

    // Union of all frames to export = top frames + parent frames across bindings.
    const allFrames = new Map<string, FrameNode>();
    for (const b of bindings) {
      allFrames.set(b.topFrame.id, b.topFrame);
      allFrames.set(b.parentFrame.id, b.parentFrame);
    }
    const framesSorted = Array.from(allFrames.values()).sort((a, b) => a.name.localeCompare(b.name));

    const exportResult = framesSorted.length
      ? await exportFrames(framesSorted, bindings, varNameById, exportScale)
      : { pngs: [] as FramePng[], nameByFrameId: new Map<string, string>() };
    const { pngs: framePngs, nameByFrameId } = exportResult;

    // Build entries (now with occurrences).
    const entries: VariableEntry[] = selectedVars.map((v) => {
      const col = collectionById.get(v.variableCollectionId)!;
      const defaultMode = col.modes.find((m) => m.modeId === col.defaultModeId);
      const values: Record<string, string> = {};
      for (const m of col.modes) {
        const raw = v.valuesByMode[m.modeId];
        values[m.name] = typeof raw === 'string' ? raw : '';
      }
      const varBindings = bindingsByVar.get(v.id) || [];
      // Dedupe occurrences by (topId|parentId).
      const seen = new Set<string>();
      const occurrences: { topFrameName: string; parentFrameName: string }[] = [];
      for (const b of varBindings) {
        const key = `${b.topFrame.id}|${b.parentFrame.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        occurrences.push({
          topFrameName: nameByFrameId.get(b.topFrame.id) || b.topFrame.name,
          parentFrameName: nameByFrameId.get(b.parentFrame.id) || b.parentFrame.name,
        });
      }
      occurrences.sort((a, b) =>
        a.topFrameName.localeCompare(b.topFrameName) ||
        a.parentFrameName.localeCompare(b.parentFrameName),
      );
      const frameNames = Array.from(new Set(occurrences.map((o) => o.topFrameName))).sort((a, b) => a.localeCompare(b));
      return {
        id: v.name,
        name: leafName(v.name),
        fullName: v.name,
        group: groupOf(v.name),
        description: v.description || '',
        collectionName: col.name,
        defaultModeName: defaultMode ? defaultMode.name : (col.modes[0] ? col.modes[0].name : ''),
        values,
        frames: frameNames,
        occurrences,
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

async function runImport(updates: ImportUpdate[]) {
  try {
    const allVars = await figma.variables.getLocalVariablesAsync('STRING');
    // Index variables by canonical name for O(1) lookup.
    const varMap = new Map(allVars.map((v) => [v.name, v]));

    // Cache collections by id to avoid redundant async lookups.
    const collectionCache = new Map<string, VariableCollection>();

    let updated = 0;
    const skippedNames: string[] = []; // variable names not found in this file
    const modeErrors: string[] = [];   // unique mode-not-found messages

    for (const update of updates) {
      const variable = varMap.get(update.variableName);
      if (!variable) {
        skippedNames.push(update.variableName);
        continue;
      }

      let collection = collectionCache.get(variable.variableCollectionId);
      if (!collection) {
        const c = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
        if (!c) {
          skippedNames.push(update.variableName);
          continue;
        }
        collection = c;
        collectionCache.set(variable.variableCollectionId, c);
      }

      let wroteAny = false;
      for (const [modeName, value] of Object.entries(update.modeValues)) {
        const mode = collection.modes.find((m) => m.name === modeName);
        if (!mode) {
          const msg = `"${modeName}" not in collection "${collection.name}"`;
          if (!modeErrors.includes(msg)) modeErrors.push(msg);
          continue;
        }
        variable.setValueForMode(mode.modeId, value);
        wroteAny = true;
      }
      if (wroteAny) updated++;
    }

    // Toast: brief summary — details shown in results panel.
    const parts = [`Updated ${updated} variable${updated === 1 ? '' : 's'}`];
    if (skippedNames.length > 0) parts.push(`${skippedNames.length} not found`);
    if (modeErrors.length > 0) parts.push(`${modeErrors.length} mode warning${modeErrors.length === 1 ? '' : 's'}`);

    postToUi({
      type: 'toast',
      level: updated > 0 ? 'success' : 'info',
      text: parts.join(' · '),
    });
    postToUi({ type: 'import-result', updated, skippedNames, modeErrors });
  } catch (err) {
    postToUi({ type: 'toast', level: 'error', text: `Import failed: ${stringifyError(err)}` });
    postToUi({ type: 'import-result', updated: 0, skippedNames: [], modeErrors: [stringifyError(err)] });
  }
}

figma.ui.onmessage = (msg: UiToPluginMessage) => {
  if (msg.type === 'export') {
    runExport(msg.selectedCollectionIds, msg.selectedPageIds, msg.exportScale);
    return;
  }
  if (msg.type === 'persist-selection') {
    persistSelection(msg.selectedCollectionIds);
    return;
  }
  if (msg.type === 'persist-page-selection') {
    persistPageSelection(msg.selectedPageIds);
    return;
  }
  if (msg.type === 'refresh') {
    pushInit();
    return;
  }
  if (msg.type === 'load-team-settings') {
    loadTeamSettings();
    return;
  }
  if (msg.type === 'save-team-settings') {
    saveTeamSettings(msg.settings);
    return;
  }
  if (msg.type === 'import') {
    runImport(msg.updates);
    return;
  }
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }
};
