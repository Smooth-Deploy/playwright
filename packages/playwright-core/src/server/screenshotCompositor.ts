/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import jpegjs from 'jpeg-js';

export function setPixel(data: Buffer, width: number, height: number, x: number, y: number, color: { r: number, g: number, b: number }) {
  if (x < 0 || x >= width || y < 0 || y >= height)
    return;
  const i = (y * width + x) * 4;
  data[i] = color.r;
  data[i + 1] = color.g;
  data[i + 2] = color.b;
  data[i + 3] = 255;
}

export function cropFullWidth(data: Buffer, imgWidth: number, imgHeight: number, by: number, bh: number): { data: Buffer, width: number, height: number } {
  const cw = imgWidth;
  let ch = Math.min(imgHeight, Math.round(cw / (16 / 9)));
  // Center vertically on the element.
  const elementCenterY = by + Math.round(bh / 2);
  let cy = Math.max(0, elementCenterY - Math.round(ch / 2));
  // Clamp so we don't exceed image bounds.
  if (cy + ch > imgHeight)
    cy = Math.max(0, imgHeight - ch);
  ch = Math.min(imgHeight - cy, ch);

  const cropped = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOffset = (cy + row) * cw * 4;
    const dstOffset = row * cw * 4;
    data.copy(cropped, dstOffset, srcOffset, srcOffset + cw * 4);
  }
  return { data: cropped, width: cw, height: ch };
}

export function cropRegion(data: Buffer, imgWidth: number, imgHeight: number, bx: number, by: number, bw: number, bh: number, dpr: number, padPx: number = 50): { data: Buffer, width: number, height: number } {
  const pad = padPx * dpr;
  let cx = Math.max(0, bx - pad);
  let cy = Math.max(0, by - pad);
  let cw = Math.min(imgWidth - cx, bw + 2 * pad);
  let ch = Math.min(imgHeight - cy, bh + 2 * pad);

  // Expand to 16:9 aspect ratio, centered on the element.
  const targetRatio = 16 / 9;
  if (cw / ch < targetRatio) {
    // Need more width.
    const newCw = Math.round(ch * targetRatio);
    const expand = newCw - cw;
    cx = Math.max(0, cx - Math.round(expand / 2));
    cw = Math.min(imgWidth - cx, newCw);
  } else {
    // Need more height.
    const newCh = Math.round(cw / targetRatio);
    const expand = newCh - ch;
    cy = Math.max(0, cy - Math.round(expand / 2));
    ch = Math.min(imgHeight - cy, newCh);
  }

  const cropped = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOffset = ((cy + row) * imgWidth + cx) * 4;
    const dstOffset = row * cw * 4;
    data.copy(cropped, dstOffset, srcOffset, srcOffset + cw * 4);
  }
  return { data: cropped, width: cw, height: ch };
}

export function compositeHighlight(jpeg: Buffer, box: { x: number, y: number, width: number, height: number }, viewport: { width: number, height: number } | null): { full: { data: Buffer, width: number, height: number }, cropped: { data: Buffer, width: number, height: number } } {
  const { width, height, data } = jpegjs.decode(jpeg, { formatAsRGBA: true, useTArray: false }) as { data: Buffer, width: number, height: number };

  // boundingBox() returns CSS pixels; the frame may be at device-pixel resolution
  // (e.g. 2x on Retina) when deviceScaleFactor isn't explicitly configured.
  // Compute the actual scale from frame dimensions vs viewport.
  const scaleX = viewport ? width / viewport.width : 1;
  const scaleY = viewport ? height / viewport.height : 1;

  // Convert box to pixel coordinates in the frame, clamped to image bounds.
  const bx = Math.max(0, Math.round(box.x * scaleX));
  const by = Math.max(0, Math.round(box.y * scaleY));
  const bw = Math.min(width - bx, Math.round(box.width * scaleX));
  const bh = Math.min(height - by, Math.round(box.height * scaleY));

  // Darken pixels outside the element bounding box (50% opacity dark overlay).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= bx && x < bx + bw && y >= by && y < by + bh)
        continue;
      const i = (y * width + x) * 4;
      data[i] = (data[i] * 0.5) | 0;       // R
      data[i + 1] = (data[i + 1] * 0.5) | 0; // G
      data[i + 2] = (data[i + 2] * 0.5) | 0; // B
    }
  }

  // Draw red border around the element (3px outline with 2px offset, scaled for DPR).
  const borderColor = { r: 255, g: 0, b: 0 };
  const dpr = Math.round(scaleX) || 1;
  const offset = 2 * dpr;
  const thickness = 3 * dpr;
  const ox = bx - offset - thickness;
  const oy = by - offset - thickness;
  const ow = bw + (offset + thickness) * 2;
  const oh = bh + (offset + thickness) * 2;

  for (let t = 0; t < thickness; t++) {
    // Top edge
    for (let x = ox; x < ox + ow; x++)
      setPixel(data, width, height, x, oy + t, borderColor);
    // Bottom edge
    for (let x = ox; x < ox + ow; x++)
      setPixel(data, width, height, x, oy + oh - 1 - t, borderColor);
    // Left edge
    for (let y = oy; y < oy + oh; y++)
      setPixel(data, width, height, ox + t, y, borderColor);
    // Right edge
    for (let y = oy; y < oy + oh; y++)
      setPixel(data, width, height, ox + ow - 1 - t, y, borderColor);
  }

  const fullData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const full = cropFullWidth(fullData, width, height, by, bh);
  const cropped = cropRegion(fullData, width, height, bx, by, bw, bh, dpr, 50);
  return { full, cropped };
}
