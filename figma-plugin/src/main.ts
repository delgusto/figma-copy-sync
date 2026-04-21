// Plugin main thread. Runs in Figma's plugin sandbox.
// Handles reading/writing node state. The UI iframe handles HTTP + React.

import type {
  CopyString,
  PluginToUiMessage,
  SelectionInfo,
  UiToPluginMessage,
} from './types';

const PLUGIN_DATA_KEY_STRING_ID = 'copySyncStringId';
const PLUGIN_DATA_KEY_PROJECT_ID = 'copySyncProjectId';

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

function getProjectId(): string | null {
  const raw = figma.root.getPluginData(PLUGIN_DATA_KEY_PROJECT_ID);
  return raw || null;
}

function setProjectId(projectId: string) {
  figma.root.setPluginData(PLUGIN_DATA_KEY_PROJECT_ID, projectId);
}

function describeSelection(): SelectionInfo[] {
  return figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    currentText: node.type === 'TEXT' ? node.characters : null,
    boundStringId: node.getPluginData(PLUGIN_DATA_KEY_STRING_ID) || null,
  }));
}

function postToUi(msg: PluginToUiMessage) {
  figma.ui.postMessage(msg);
}

// Send initial state once UI boots.
postToUi({
  type: 'init',
  projectId: getProjectId(),
  selection: describeSelection(),
});

figma.on('selectionchange', () => {
  postToUi({ type: 'selection-change', selection: describeSelection() });
});

async function applyStringToNode(node: SceneNode, copy: CopyString) {
  if (node.type !== 'TEXT') return;
  // Loading fonts is mandatory before setting characters.
  for (const font of node.getRangeAllFontNames(0, node.characters.length)) {
    await figma.loadFontAsync(font);
  }
  node.characters = copy.en;
}

async function refreshNodesByBinding(nodes: readonly SceneNode[], strings: CopyString[]): Promise<{updated: number; missing: string[]}> {
  const byId = new Map(strings.map((s) => [s.id, s]));
  let updated = 0;
  const missing: string[] = [];
  for (const node of nodes) {
    const stringId = node.getPluginData(PLUGIN_DATA_KEY_STRING_ID);
    if (!stringId) continue;
    const copy = byId.get(stringId);
    if (!copy) {
      missing.push(stringId);
      continue;
    }
    // Only serve approved/live strings.
    if (copy.status !== 'approved' && copy.status !== 'live') continue;
    await applyStringToNode(node, copy);
    updated++;
  }
  return { updated, missing };
}

function collectTextNodesOnCurrentPage(): SceneNode[] {
  return figma.currentPage.findAllWithCriteria({ types: ['TEXT'] }) as SceneNode[];
}

figma.ui.onmessage = async (msg: UiToPluginMessage) => {
  if (msg.type === 'bind-file-to-project') {
    setProjectId(msg.projectId);
    postToUi({ type: 'toast', level: 'success', text: `File bound to "${msg.projectId}"` });
    postToUi({ type: 'init', projectId: msg.projectId, selection: describeSelection() });
    return;
  }

  if (msg.type === 'bind-layer') {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (!node || !('setPluginData' in node)) {
      postToUi({ type: 'toast', level: 'error', text: 'Layer not found' });
      return;
    }
    node.setPluginData(PLUGIN_DATA_KEY_STRING_ID, msg.stringId);
    postToUi({ type: 'toast', level: 'success', text: `Bound to ${msg.stringId}` });
    postToUi({ type: 'selection-change', selection: describeSelection() });
    return;
  }

  if (msg.type === 'unbind-layer') {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (!node || !('setPluginData' in node)) return;
    node.setPluginData(PLUGIN_DATA_KEY_STRING_ID, '');
    postToUi({ type: 'toast', level: 'info', text: 'Unbound' });
    postToUi({ type: 'selection-change', selection: describeSelection() });
    return;
  }

  if (msg.type === 'refresh-selection') {
    const selection = figma.currentPage.selection;
    const result = await refreshNodesByBinding(selection, msg.strings);
    const suffix = result.missing.length ? `, missing: ${result.missing.join(', ')}` : '';
    postToUi({
      type: 'toast',
      level: result.updated ? 'success' : 'info',
      text: `Updated ${result.updated} layer${result.updated === 1 ? '' : 's'}${suffix}`,
    });
    return;
  }

  if (msg.type === 'refresh-page') {
    const nodes = collectTextNodesOnCurrentPage();
    const result = await refreshNodesByBinding(nodes, msg.strings);
    const suffix = result.missing.length ? `, ${result.missing.length} missing ID${result.missing.length === 1 ? '' : 's'}` : '';
    postToUi({
      type: 'toast',
      level: result.updated ? 'success' : 'info',
      text: `Updated ${result.updated} layer${result.updated === 1 ? '' : 's'}${suffix}`,
    });
    return;
  }
};
