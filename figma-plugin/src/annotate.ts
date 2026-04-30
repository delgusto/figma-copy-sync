// Re-encode a frame PNG with outline rectangles drawn over each text node
// that's bound to a tracked copy variable. Runs in the plugin UI iframe
// (full Canvas API). Pure: takes bytes + rects, returns new bytes.

import type { FramePng } from './types';

// Stable hash -> hue. Same variable always gets same color across exports.
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function colorFor(variableName: string): string {
  const hue = stringHash(variableName) % 360;
  return `hsl(${hue} 85% 50%)`;
}

async function bytesToImageBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  // Cast: TS lib.dom narrows Uint8Array<ArrayBufferLike> vs ArrayBuffer
  // strictly. Runtime accepts the typed array directly.
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
  return await createImageBitmap(blob);
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      resolve(new Uint8Array(buf));
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function annotateFrame(frame: FramePng): Promise<FramePng> {
  if (!frame.rects.length) return frame;

  const bitmap = await bytesToImageBitmap(frame.bytes);
  // Use OffscreenCanvas where available; fall back to a DOM canvas.
  const canvas: any =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), {
          width: bitmap.width,
          height: bitmap.height,
        });
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  if (!ctx) return frame;

  ctx.drawImage(bitmap as any, 0, 0);

  // Stroke width scaled to image — keeps outlines visible on big frames
  // without dominating small ones.
  const stroke = Math.max(2, Math.round(Math.min(bitmap.width, bitmap.height) / 400));
  const padding = Math.round(stroke * 1.5);

  for (const r of frame.rects) {
    const color = colorFor(r.variableName);
    (ctx as any).lineWidth = stroke;
    (ctx as any).strokeStyle = color;
    // Slightly inflated rect so outline sits around the text, not on top of it.
    (ctx as any).strokeRect(
      r.x - padding,
      r.y - padding,
      r.w + padding * 2,
      r.h + padding * 2,
    );
  }

  // Convert back to PNG bytes.
  let blob: Blob;
  if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  } else {
    blob = await new Promise<Blob>((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png',
      );
    });
  }
  const bytes = await blobToBytes(blob);
  return { ...frame, bytes };
}

export async function annotateAll(frames: FramePng[]): Promise<FramePng[]> {
  const out: FramePng[] = [];
  for (const f of frames) {
    out.push(await annotateFrame(f));
  }
  return out;
}
