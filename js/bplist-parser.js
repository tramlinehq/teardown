/**
 * Apple Binary Property List (bplist00) parser.
 *
 * Parses the binary plist format used inside iOS IPA bundles
 * (Info.plist, embedded.mobileprovision, etc.) and returns a
 * native JS value (object / array / string / number / etc.).
 *
 * Reference: https://opensource.apple.com/source/CF/CF-550/CFBinaryPList.c
 */
class BPlistParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offsets = [];
    this.objectRefSize = 0;
    this._parsed = new Map(); // cache: object index -> parsed value
  }

  // ── public API ──

  parse() {
    // magic check
    const magic = this._ascii(0, 6);
    if (magic !== 'bplist') {
      throw new Error('Not a binary plist file');
    }

    // trailer lives in the last 32 bytes
    const tOff = this.buffer.byteLength - 32;
    const offsetIntSize = this.bytes[tOff + 6];
    this.objectRefSize = this.bytes[tOff + 7];
    const numObjects = this._readBigEndian(tOff + 8, 8);
    const topIndex = this._readBigEndian(tOff + 16, 8);
    const tableOffset = this._readBigEndian(tOff + 24, 8);

    // offset table
    this.offsets = new Array(numObjects);
    for (let i = 0; i < numObjects; i++) {
      this.offsets[i] = this._readBigEndian(tableOffset + i * offsetIntSize, offsetIntSize);
    }

    return this._parseObject(topIndex);
  }

  // ── internals ──

  _parseObject(index) {
    if (this._parsed.has(index)) return this._parsed.get(index);

    const offset = this.offsets[index];
    const marker = this.bytes[offset];
    const type = (marker & 0xf0) >>> 4;
    const info = marker & 0x0f;

    let value;
    switch (type) {
      case 0x0: value = this._parseSimple(info); break;
      case 0x1: value = this._parseInt(offset, info); break;
      case 0x2: value = this._parseReal(offset, info); break;
      case 0x3: value = this._parseDate(offset); break;
      case 0x4: value = this._parseData(offset, info); break;
      case 0x5: value = this._parseAscii(offset, info); break;
      case 0x6: value = this._parseUnicode(offset, info); break;
      case 0x8: value = this._parseUid(offset, info); break;
      case 0xa: value = this._parseArray(offset, info); break;
      case 0xc: value = this._parseArray(offset, info); break; // set
      case 0xd: value = this._parseDict(offset, info); break;
      default: value = undefined;
    }

    this._parsed.set(index, value);
    return value;
  }

  // ── type parsers ──

  _parseSimple(info) {
    if (info === 0x08) return false;
    if (info === 0x09) return true;
    return null;
  }

  _parseInt(offset, info) {
    const byteCount = 1 << info;
    return this._readBigEndian(offset + 1, byteCount);
  }

  _parseReal(offset, info) {
    const byteCount = 1 << info;
    if (byteCount === 4) return this.view.getFloat32(offset + 1, false);
    if (byteCount === 8) return this.view.getFloat64(offset + 1, false);
    return 0;
  }

  _parseDate(offset) {
    const secs = this.view.getFloat64(offset + 1, false);
    // Apple epoch: 2001-01-01T00:00:00Z
    return new Date(Date.UTC(2001, 0, 1) + secs * 1000);
  }

  _parseData(offset, info) {
    const { count, headerLen } = this._getCount(offset, info);
    return this.bytes.slice(offset + headerLen, offset + headerLen + count);
  }

  _parseAscii(offset, info) {
    const { count, headerLen } = this._getCount(offset, info);
    return this._ascii(offset + headerLen, count);
  }

  _parseUnicode(offset, info) {
    const { count, headerLen } = this._getCount(offset, info);
    const start = offset + headerLen;
    let s = '';
    for (let i = 0; i < count; i++) {
      s += String.fromCharCode(this.view.getUint16(start + i * 2, false));
    }
    return s;
  }

  _parseUid(offset, info) {
    const byteCount = info + 1;
    return { UID: this._readBigEndian(offset + 1, byteCount) };
  }

  _parseArray(offset, info) {
    const { count, headerLen } = this._getCount(offset, info);
    const refsStart = offset + headerLen;
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      const ref = this._readBigEndian(refsStart + i * this.objectRefSize, this.objectRefSize);
      arr[i] = this._parseObject(ref);
    }
    return arr;
  }

  _parseDict(offset, info) {
    const { count, headerLen } = this._getCount(offset, info);
    const keysStart = offset + headerLen;
    const valsStart = keysStart + count * this.objectRefSize;
    const dict = {};
    for (let i = 0; i < count; i++) {
      const kRef = this._readBigEndian(keysStart + i * this.objectRefSize, this.objectRefSize);
      const vRef = this._readBigEndian(valsStart + i * this.objectRefSize, this.objectRefSize);
      dict[this._parseObject(kRef)] = this._parseObject(vRef);
    }
    return dict;
  }

  // ── helpers ──

  /** Read count, handling the 0x0F extension byte. */
  _getCount(offset, info) {
    if (info !== 0x0f) return { count: info, headerLen: 1 };
    const intMarker = this.bytes[offset + 1];
    const intInfo = intMarker & 0x0f;
    const byteCount = 1 << intInfo;
    const count = this._readBigEndian(offset + 2, byteCount);
    return { count, headerLen: 2 + byteCount };
  }

  /** Read a big-endian unsigned integer of `size` bytes at `offset`. */
  _readBigEndian(offset, size) {
    let val = 0;
    for (let i = 0; i < size; i++) {
      val = val * 256 + this.bytes[offset + i];
    }
    return val;
  }

  /** Read `len` ASCII characters from `offset`. */
  _ascii(offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[offset + i]);
    return s;
  }
}
