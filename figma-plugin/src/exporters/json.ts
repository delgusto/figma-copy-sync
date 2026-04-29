import type { ExportPayload } from '../types';

// Stable, machine-readable JSON for devs to consume.
export function buildJson(payload: ExportPayload): string {
  const body = {
    exportedAt: payload.exportedAt,
    fileName: payload.fileName,
    fileKey: payload.fileKey,
    modes: payload.modes,
    variables: payload.variables.map((v) => ({
      id: v.id,
      fullName: v.fullName,
      name: v.name,
      group: v.group,
      description: v.description,
      collection: v.collectionName,
      defaultMode: v.defaultModeName,
      values: v.values,           // { [modeName]: value }
      frames: v.frames,
    })),
  };
  return JSON.stringify(body, null, 2);
}
