// Shared types between plugin main thread and UI iframe.

export interface CollectionInfo {
  id: string;
  name: string;
  stringVariableCount: number;
  isCopyByDefault: boolean; // name starts with "Copy"
}

export interface PageInfo {
  id: string;
  name: string;
  frameCount: number; // top-level FRAME children (indicative)
}

export interface Occurrence {
  topFrameName: string;     // top-level frame on the page
  parentFrameName: string;  // nearest FRAME ancestor of the text node (==topFrameName if none nested)
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
  frames: string[];                   // top-level frame names, de-duplicated + sorted (kept for json/xlsx)
  occurrences: Occurrence[];          // de-duplicated (top, parent) pairs for HTML rendering
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

// One person on the project team (rendered in the team table atop each export).
export interface TeamMember {
  role: string;
  name: string;
}

// A named, reusable set of team members. Stored per-user via clientStorage.
export interface TeamTemplate {
  id: string;
  name: string;
  members: TeamMember[];
}

// All team templates plus which one auto-loads. Persisted across files.
export interface TeamSettings {
  templates: TeamTemplate[];
  defaultTemplateId: string | null;
}

export const MAX_TEAM_MEMBERS = 12;

export interface ExportPayload {
  fileName: string;
  fileKey: string;
  exportedAt: string; // ISO
  modes: string[];    // ordered union of modes across selected collections
  variables: VariableEntry[];
  frames: FramePng[];
  team?: TeamMember[]; // optional project team, set by the UI at export time
}

// Plugin -> UI messages.
export type PluginToUiMessage =
  | { type: 'init'; collections: CollectionInfo[]; pages: PageInfo[]; persistedSelection: string[] | null; persistedPageSelection: string[] | null }
  | { type: 'progress'; phase: 'scanning' | 'exporting-frames' | 'building-bundle'; current: number; total: number; label?: string }
  | { type: 'export-result'; payload: ExportPayload }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string }
  | { type: 'team-settings'; settings: TeamSettings }
  | { type: 'import-result'; updated: number; skippedNames: string[]; modeErrors: string[] };

// Represents one row from an imported XLSX: variable to update + new mode values.
export interface ImportUpdate {
  // Canonical Figma variable name (the "id" column in the exported XLSX).
  variableName: string;
  // Map of mode name → new string value. Only mode columns from the XLSX are included.
  modeValues: Record<string, string>;
}

// UI -> plugin messages.
export type UiToPluginMessage =
  | { type: 'export'; selectedCollectionIds: string[]; selectedPageIds: string[]; exportScale: 1 | 2 }
  | { type: 'persist-selection'; selectedCollectionIds: string[] }
  | { type: 'persist-page-selection'; selectedPageIds: string[] }
  | { type: 'refresh' }
  | { type: 'cancel' }
  | { type: 'load-team-settings' }
  | { type: 'save-team-settings'; settings: TeamSettings }
  | { type: 'import'; updates: ImportUpdate[] };
