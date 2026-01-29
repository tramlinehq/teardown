/**
 * Android Binary XML (AXML) parser.
 *
 * Parses the compiled binary XML format used in Android APK files
 * (e.g. AndroidManifest.xml) and produces a JS object tree.
 *
 * Reference: frameworks/base/include/androidfw/ResourceTypes.h
 */
class AXMLParser {
  // Chunk types
  static RES_STRING_POOL_TYPE = 0x0001;
  static RES_XML_TYPE = 0x0003;
  static RES_XML_START_NAMESPACE_TYPE = 0x0100;
  static RES_XML_END_NAMESPACE_TYPE = 0x0101;
  static RES_XML_START_ELEMENT_TYPE = 0x0102;
  static RES_XML_END_ELEMENT_TYPE = 0x0103;
  static RES_XML_CDATA_TYPE = 0x0104;
  static RES_XML_RESOURCE_MAP_TYPE = 0x0180;

  // Value types
  static TYPE_NULL = 0x00;
  static TYPE_REFERENCE = 0x01;
  static TYPE_ATTRIBUTE = 0x02;
  static TYPE_STRING = 0x03;
  static TYPE_FLOAT = 0x04;
  static TYPE_DIMENSION = 0x05;
  static TYPE_FRACTION = 0x06;
  static TYPE_INT_DEC = 0x10;
  static TYPE_INT_HEX = 0x11;
  static TYPE_INT_BOOLEAN = 0x12;

  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = 0;
    this.strings = [];
    this.resourceIds = [];
    this.namespaces = {}; // uri string -> prefix string
  }

  // ── low-level readers (all little-endian) ──

  readUint8() {
    return this.view.getUint8(this.offset++);
  }

  readUint16() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readUint32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readInt32() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  // ── public API ──

  parse() {
    const type = this.readUint16();
    const headerSize = this.readUint16();
    const fileSize = this.readUint32();

    if (type !== AXMLParser.RES_XML_TYPE) {
      throw new Error('Not a valid Android Binary XML file');
    }

    const root = { tag: '#document', attributes: {}, children: [] };
    const stack = [root];

    while (this.offset < fileSize && this.offset < this.buffer.byteLength) {
      const chunkStart = this.offset;
      const chunkType = this.readUint16();
      const chunkHeaderSize = this.readUint16();
      const chunkSize = this.readUint32();

      if (chunkSize < 8 || chunkStart + chunkSize > this.buffer.byteLength) break;

      switch (chunkType) {
        case AXMLParser.RES_STRING_POOL_TYPE:
          this._parseStringPool(chunkStart, chunkSize);
          break;
        case AXMLParser.RES_XML_RESOURCE_MAP_TYPE:
          this._parseResourceMap(chunkSize);
          break;
        case AXMLParser.RES_XML_START_NAMESPACE_TYPE:
          this._parseStartNamespace();
          break;
        case AXMLParser.RES_XML_END_NAMESPACE_TYPE:
          this._skipNodeBody();
          break;
        case AXMLParser.RES_XML_START_ELEMENT_TYPE: {
          const el = this._parseStartElement(chunkStart);
          stack[stack.length - 1].children.push(el);
          stack.push(el);
          break;
        }
        case AXMLParser.RES_XML_END_ELEMENT_TYPE:
          this._skipNodeBody();
          if (stack.length > 1) stack.pop();
          break;
        case AXMLParser.RES_XML_CDATA_TYPE:
          break; // skip
      }

      this.offset = chunkStart + chunkSize;
    }

    return root.children[0] || root;
  }

  // ── chunk parsers ──

  _parseStringPool(chunkStart, chunkSize) {
    const stringCount = this.readUint32();
    const styleCount = this.readUint32();
    const flags = this.readUint32();
    const stringsStart = this.readUint32(); // relative to chunkStart
    const stylesStart = this.readUint32();

    const isUTF8 = (flags & (1 << 8)) !== 0;

    const stringOffsets = new Array(stringCount);
    for (let i = 0; i < stringCount; i++) {
      stringOffsets[i] = this.readUint32();
    }

    // skip style offsets
    this.offset += styleCount * 4;

    const dataStart = chunkStart + stringsStart;
    this.strings = new Array(stringCount);
    for (let i = 0; i < stringCount; i++) {
      this.strings[i] = this._readStringAt(dataStart + stringOffsets[i], isUTF8);
    }
  }

  _readStringAt(offset, isUTF8) {
    const saved = this.offset;
    this.offset = offset;

    try {
      if (isUTF8) {
        // utf-16 char count (skip, only used for buffer sizing)
        let u16len = this.readUint8();
        if (u16len & 0x80) this.readUint8();

        // utf-8 byte count
        let u8len = this.readUint8();
        if (u8len & 0x80) {
          u8len = ((u8len & 0x7f) << 8) | this.readUint8();
        }

        const bytes = new Uint8Array(this.buffer, this.offset, u8len);
        return new TextDecoder('utf-8').decode(bytes);
      }

      // UTF-16LE
      let charCount = this.readUint16();
      if (charCount & 0x8000) {
        charCount = ((charCount & 0x7fff) << 16) | this.readUint16();
      }

      let s = '';
      for (let i = 0; i < charCount; i++) {
        s += String.fromCharCode(this.view.getUint16(this.offset + i * 2, true));
      }
      return s;
    } finally {
      this.offset = saved;
    }
  }

  _parseResourceMap(chunkSize) {
    const count = (chunkSize - 8) >>> 2;
    this.resourceIds = new Array(count);
    for (let i = 0; i < count; i++) {
      this.resourceIds[i] = this.readUint32();
    }
  }

  _parseStartNamespace() {
    this.readUint32(); // lineNumber
    this.readUint32(); // comment
    const prefix = this.readUint32();
    const uri = this.readUint32();
    const prefixStr = this._str(prefix);
    const uriStr = this._str(uri);
    if (prefixStr && uriStr) this.namespaces[uriStr] = prefixStr;
  }

  _skipNodeBody() {
    // lineNumber + comment + two uint32s (ns, name or prefix, uri)
    this.offset += 16;
  }

  _parseStartElement(chunkStart) {
    const lineNumber = this.readUint32();
    const comment = this.readUint32();
    const ns = this.readInt32();
    const name = this.readUint32();
    const attrStart = this.readUint16();
    const attrSize = this.readUint16();
    const attrCount = this.readUint16();
    /* idIndex */ this.readUint16();
    /* classIndex */ this.readUint16();
    /* styleIndex */ this.readUint16();

    // seek to first attribute (attrStart is relative to the attrExt struct
    // which begins at chunkStart + 16)
    this.offset = chunkStart + 16 + attrStart;

    const element = {
      tag: this._str(name),
      attributes: {},
      children: [],
      _rawAttrs: [],
    };

    for (let i = 0; i < attrCount; i++) {
      const attrOffset = this.offset;
      const aNs = this.readInt32();
      const aName = this.readUint32();
      const aRawValue = this.readInt32();
      /* valueSize */ this.readUint16();
      /* res0 */ this.readUint8();
      const aType = this.readUint8();
      const aData = this.readUint32();

      // ensure we advance by exactly attrSize
      this.offset = attrOffset + (attrSize || 20);

      const nameStr = this._str(aName);
      const nsStr = aNs >= 0 ? this._str(aNs) : null;
      const value = aRawValue >= 0
        ? this._str(aRawValue)
        : this._resolveValue(aType, aData);

      const raw = { namespace: nsStr, name: nameStr, value, type: aType, data: aData };
      element._rawAttrs.push(raw);

      const prefix = nsStr ? this.namespaces[nsStr] : null;
      const key = prefix ? `${prefix}:${nameStr}` : nameStr;
      element.attributes[key] = value;
    }

    return element;
  }

  // ── helpers ──

  _str(index) {
    if (index < 0 || index >= this.strings.length) return null;
    return this.strings[index];
  }

  _resolveValue(type, data) {
    switch (type) {
      case AXMLParser.TYPE_STRING: return this._str(data);
      case AXMLParser.TYPE_INT_DEC: return data;
      case AXMLParser.TYPE_INT_HEX: return '0x' + data.toString(16);
      case AXMLParser.TYPE_INT_BOOLEAN: return data !== 0;
      case AXMLParser.TYPE_REFERENCE: return '@0x' + data.toString(16);
      case AXMLParser.TYPE_ATTRIBUTE: return '?0x' + data.toString(16);
      case AXMLParser.TYPE_FLOAT: {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, data);
        return new DataView(buf).getFloat32(0);
      }
      case AXMLParser.TYPE_DIMENSION: {
        const units = ['px', 'dp', 'sp', 'pt', 'in', 'mm'];
        return this._complexToFloat(data) + (units[data & 0x0f] || '');
      }
      case AXMLParser.TYPE_FRACTION: {
        const types = ['%', '%p'];
        return this._complexToFloat(data) + (types[data & 0x0f] || '');
      }
      case AXMLParser.TYPE_NULL: return null;
      default: return data;
    }
  }

  _complexToFloat(data) {
    const mantissa = (data >> 8) & 0xffffff;
    const radix = (data >> 4) & 0x03;
    const factors = [1.0, 1 / (1 << 7), 1 / (1 << 15), 1 / (1 << 23)];
    return mantissa * factors[radix];
  }
}
