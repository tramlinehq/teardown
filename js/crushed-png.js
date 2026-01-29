/**
 * Apple CgBI ("crushed") PNG handler.
 *
 * Xcode's build pipeline modifies PNG files before packaging them into
 * an IPA.  The resulting files are technically invalid PNGs that browsers
 * cannot decode.  Changes made by Xcode:
 *
 *   1. A proprietary `CgBI` chunk is inserted before `IHDR`.
 *   2. The zlib header / checksum is stripped from IDAT data
 *      (raw deflate only).
 *   3. Pixel byte order is swapped from RGBA → BGRA.
 *   4. Alpha is premultiplied into RGB channels.
 *
 * This class detects CgBI PNGs, reverses all four modifications, and
 * returns a displayable Blob via an offscreen <canvas>.
 *
 * Only 8-bit RGB (color type 2) and 8-bit RGBA (color type 6) are
 * supported — this covers virtually all iOS app icons.  Anything else
 * is returned as-is (the browser may or may not display it).
 */
class CrushedPNG {
  /**
   * Convert raw PNG bytes into a browser-displayable Blob.
   * Handles both normal and CgBI-crushed PNGs.
   *
   * @param {Uint8Array} data
   * @returns {Promise<Blob>}
   */
  static async toBlob(data) {
    if (!this._isPNG(data)) {
      return new Blob([data], { type: 'application/octet-stream' });
    }

    const chunks = this._readChunks(data);
    if (!chunks.some(c => c.type === 'CgBI')) {
      // Normal PNG — pass through
      return new Blob([data], { type: 'image/png' });
    }

    // CgBI detected — uncrush
    return this._uncrush(chunks);
  }

  // ── core uncrush pipeline ───────────────────────

  static async _uncrush(chunks) {
    const ihdr = chunks.find(c => c.type === 'IHDR');
    if (!ihdr) throw new Error('Missing IHDR chunk');

    const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    const width = view.getUint32(0);
    const height = view.getUint32(4);
    const bitDepth = ihdr.data[8];
    const colorType = ihdr.data[9];

    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
      throw new Error(`Unsupported CgBI format: depth=${bitDepth} color=${colorType}`);
    }

    const bpp = colorType === 6 ? 4 : 3; // bytes per pixel

    // 1. Concatenate all IDAT payloads
    const compressed = this._concat(
      chunks.filter(c => c.type === 'IDAT').map(c => c.data)
    );

    // 2. Raw-inflate (no zlib header)
    const inflated = await this._rawInflate(compressed);

    // 3. Reverse PNG row filters & fix byte order + premultiply
    const rgba = this._decodePixels(inflated, width, height, bpp);

    // 4. Paint into a canvas and export
    return this._toBlob(rgba, width, height);
  }

  // ── pixel decoding ──────────────────────────────

  static _decodePixels(inflated, width, height, bpp) {
    const stride = 1 + width * bpp; // 1 filter-type byte + row data
    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(width * bpp); // prior row (starts zeroed)
    const curr = new Uint8Array(width * bpp);

    for (let y = 0; y < height; y++) {
      const rowOff = y * stride;
      const filterType = inflated[rowOff];

      // reverse the filter for this row
      for (let i = 0; i < width * bpp; i++) {
        const raw = inflated[rowOff + 1 + i];
        const a = i >= bpp ? curr[i - bpp] : 0; // left neighbour
        const b = prev[i];                       // above
        const c = i >= bpp ? prev[i - bpp] : 0;  // above-left

        switch (filterType) {
          case 0: curr[i] = raw; break;                                      // None
          case 1: curr[i] = (raw + a) & 0xff; break;                        // Sub
          case 2: curr[i] = (raw + b) & 0xff; break;                        // Up
          case 3: curr[i] = (raw + ((a + b) >>> 1)) & 0xff; break;          // Average
          case 4: curr[i] = (raw + this._paeth(a, b, c)) & 0xff; break;     // Paeth
          default: curr[i] = raw;
        }
      }

      // convert BGRA → RGBA  +  undo premultiplied alpha
      for (let x = 0; x < width; x++) {
        const s = x * bpp;
        const d = (y * width + x) * 4;

        // CgBI stores pixels as B, G, R, A
        const B = curr[s];
        const G = curr[s + 1];
        const R = curr[s + 2];
        const A = bpp === 4 ? curr[s + 3] : 255;

        if (A === 0) {
          out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0;
        } else if (A < 255 && bpp === 4) {
          // undo premultiply: C_actual = C_stored * 255 / A
          out[d]     = Math.min(255, Math.round(R * 255 / A));
          out[d + 1] = Math.min(255, Math.round(G * 255 / A));
          out[d + 2] = Math.min(255, Math.round(B * 255 / A));
          out[d + 3] = A;
        } else {
          out[d]     = R;
          out[d + 1] = G;
          out[d + 2] = B;
          out[d + 3] = A;
        }
      }

      prev.set(curr);
    }

    return out;
  }

  // ── canvas export ───────────────────────────────

  static _toBlob(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(rgba.buffer), width, height),
      0, 0,
    );
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/png',
      );
    });
  }

  // ── PNG chunk reader ────────────────────────────

  static _readChunks(data) {
    const chunks = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let off = 8; // skip 8-byte PNG signature

    while (off + 8 <= data.byteLength) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(
        data[off + 4], data[off + 5], data[off + 6], data[off + 7],
      );
      const chunkData = data.subarray(off + 8, off + 8 + len);
      chunks.push({ type, data: chunkData });
      off += 12 + len; // 4 len + 4 type + data + 4 CRC
      if (type === 'IEND') break;
    }
    return chunks;
  }

  // ── raw inflate (no zlib header) ────────────────

  static async _rawInflate(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream API not available');
    }
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();

    const reader = ds.readable.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return this._concat(parts);
  }

  // ── helpers ─────────────────────────────────────

  static _isPNG(d) {
    return d.length > 8
      && d[0] === 0x89 && d[1] === 0x50
      && d[2] === 0x4e && d[3] === 0x47;
  }

  static _concat(arrays) {
    const total = arrays.reduce((s, a) => s + a.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      out.set(a instanceof Uint8Array ? a : new Uint8Array(a), off);
      off += a.byteLength;
    }
    return out;
  }

  static _paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }
}
