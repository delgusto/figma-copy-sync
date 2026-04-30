// Re-encode a frame PNG with outline rectangles drawn over text nodes
// bound to tracked copy variables. Two flavours:
//   - annotateFrameAll: draw all rects, color-coded per variable. Used for
//     the bundled frames/*.png files (devs see everything).
//   - annotateFrameForVariable: draw ONLY the current variable's rect.
//     Used per-row in strings.html so each row's screenshot points at the
//     specific copy element being shown.
// Runs in the plugin UI iframe (full Canvas API). Pure functions: take
// bytes + rects + a target, return new bytes.

import type { CopyRect, FramePng } from './types';

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

async function drawAndEncode(
  bitmap: ImageBitmap,
  rects: CopyRect[],
  highlightVariableName: string | null,
): Promise<Uint8Array> {
  const canvas: any =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), {
          width: bitmap.width,
          height: bitmap.height,
        });
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) {
    // Fallback: return original bytes encoded from the bitmap (no annotation).
    return await encodeBitmap(bitmap);
  }

  ctx.drawImage(bitmap as any, 0, 0);

  // Stroke width scaled to image. Highlighted rect a touch thicker.
  const baseStroke = Math.max(2, Math.round(Math.min(bitmap.width, bitmap.height) / 400));
  const padding = Math.round(baseStroke * 1.5);

  for (const r of rects) {
    const isCurrent = highlightVariableName === r.variableName;
    if (highlightVariableName !== null && !isCurrent) continue;
    (ctx as any).lineWidth = isCurrent ? Math.round(baseStroke * 1.6) : baseStroke;
    (ctx as any).strokeStyle = colorFor(r.variableName);
    (ctx as any).strokeRect(
      r.x - padding,
      r.y - padding,
      r.w + padding * 2,
      r.h + padding * 2,
    );
  }

  return await canvasToBytes(canvas);
}

async function canvasToBytes(canvas: any): Promise<Uint8Array> {
  let blob: Blob;
  if (typeof canvas.convertToBlob === 'function') {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  } else {
    blob = await new Promise<Blob>((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png',
      );
    });
  }
  return await blobToBytes(blob);
}

async function encodeBitmap(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas: any =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap as any, 0, 0);
  return await canvasToBytes(canvas);
}

/** Bundle-side: draw every rect, color-coded. Used for `frames/*.png`. */
export async function annotateFrameAll(frame: FramePng): Promise<FramePng> {
  if (!frame.rects.length) return frame;
  const bitmap = await bytesToImageBitmap(frame.bytes);
  const bytes = await drawAndEncode(bitmap, frame.rects, null);
  return { ...frame, bytes };
}

/**
 * HTML-side: draw only the supplied variable's rect. Returns PNG bytes.
 * Caller should cache results — this re-decodes the source bitmap each call.
 */
export async function annotateFrameForVariable(
  frame: FramePng,
  variableName: string,
): Promise<Uint8Array> {
  // No matching rect for this variable in this frame => return original.
  if (!frame.rects.some((r) => r.variableName === variableName)) return frame.bytes;
  const bitmap = await bytesToImageBitmap(frame.bytes);
  return await drawAndEncode(bitmap, frame.rects, variableName);
}
