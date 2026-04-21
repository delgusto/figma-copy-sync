// Shared types. Kept small and dependency-free so the plugin main thread,
// UI, and future API can all import without friction.

export type StringStatus = 'draft' | 'review' | 'approved' | 'live';

export interface CopyString {
  id: string;          // e.g. "checkout.payment.cta.primary"
  area: string;        // e.g. "payment"
  context?: string;    // writer notes
  charLimit?: number;  // optional max length
  status: StringStatus;
  en: string;          // English copy. More locales added later as optional fields.
}

export interface Project {
  id: string;          // first segment of string IDs (e.g. "checkout")
  name: string;        // human label
  strings: CopyString[];
}

// Messages between plugin main thread and UI. Keep the surface small.
export type PluginToUiMessage =
  | { type: 'init'; projectId: string | null; selection: SelectionInfo[] }
  | { type: 'selection-change'; selection: SelectionInfo[] }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };

export type UiToPluginMessage =
  | { type: 'bind-file-to-project'; projectId: string }
  | { type: 'bind-layer'; nodeId: string; stringId: string }
  | { type: 'unbind-layer'; nodeId: string }
  | { type: 'refresh-selection'; strings: CopyString[] }
  | { type: 'refresh-page'; strings: CopyString[] };

export interface SelectionInfo {
  id: string;
  name: string;
  type: string;           // Figma node type
  currentText: string | null;  // null if not a text node
  boundStringId: string | null;
}
