import type { ExportPayload } from '../types';

// Stable, machine-readable JSON for devs to consume.
export function buildJson(payload: ExportPayload): string {
  const body = {
    exportedAt: payload.exportedAt,
    fileName: payload.fileName,
    fileKey: payload.fileKey,
    variables: payload.variables.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      collection: v.collectionName,
      value: v.value,
      frames: v.frames,
    })),
  };
  return JSON.stringify(body, null, 2);
}
