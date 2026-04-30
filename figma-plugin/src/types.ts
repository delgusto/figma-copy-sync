// Shared types between plugin main thread and UI iframe.

export interface CollectionInfo {
  id: string;
  name: string;
  stringVariableCount: number;
  isCopyByDefault: boolean; // name starts with "Copy"
}

export interface VariableEntry {
  id: string;        // canonical name (Figma variable name, e.g. "checkout/payment/cta-primary")
  name: string;      // leaf name (last `/`-segment); useful for display
  fullName: string;  // full slash-path, same as id
  group: string;     // everything before the last `/` (empty if no slash)
  description: string;
  collectionName: string;
  defaultModeName: string;            // mode designated default by the collection
  values: Record<string, string>;     // keyed by mode name
  frames: string[];                   // frame names (de-duplicated, sorted)
}

export interface CopyRect {
  variableId: string;     // Figma variable id (not the canonical name)
  variableName: string;   // canonical name for color stability + label
  // PNG-pixel coords (already multiplied by export scale).
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FramePng {
  // Stable filename used in the ZIP (sanitized).
  filename: string;
  // Display name (raw frame name).
  name: string;
  // Page that contains the frame.
  pageName: string;
  // PNG bytes.
  bytes: Uint8Array;
  // PNG dimensions (post-scale).
  width: number;
  height: number;
  // Bounds of every text node in the frame that's bound to a selected
  // variable. Used by the UI iframe to draw outlines on top of the PNG.
  rects: CopyRect[];
}

export interface ExportPayload {
  fileName: string;
  fileKey: string;
  exportedAt: string; // ISO
  modes: string[];    // ordered union of modes across selected collections
  variables: VariableEntry[];
  frames: FramePng[];
}

// Plugin -> UI messages.
export type PluginToUiMessage =
  | { type: 'init'; collections: CollectionInfo[]; persistedSelection: string[] | null }
  | { type: 'progress'; phase: 'scanning' | 'exporting-frames' | 'building-bundle'; current: number; total: number; label?: string }
  | { type: 'export-result'; payload: ExportPayload }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };

// UI -> plugin messages.
export type UiToPluginMessage =
  | { type: 'export'; selectedCollectionIds: string[] }
  | { type: 'persist-selection'; selectedCollectionIds: string[] }
  | { type: 'refresh' }
  | { type: 'cancel' };
