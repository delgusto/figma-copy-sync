// Shared types between plugin main thread and UI iframe.

export interface CollectionInfo {
  id: string;
  name: string;
  stringVariableCount: number;
  isCopyByDefault: boolean; // name starts with "Copy"
}

export interface VariableEntry {
  id: string;        // canonical name (Figma variable name, e.g. "checkout/payment/cta-primary")
  name: string;      // same as id; preserved if we ever split internal id from display name
  description: string;
  collectionName: string;
  value: string;     // value in default mode
  frames: string[];  // frame names (de-duplicated, sorted)
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
}

export interface ExportPayload {
  fileName: string;
  fileKey: string;
  exportedAt: string; // ISO
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
  | { type: 'cancel' };
