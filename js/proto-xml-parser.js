/**
 * Protobuf wire-format decoder + proto-based XML parser for AAB manifests.
 *
 * AAB AndroidManifest.xml is serialised using the AAPT2 proto schema
 * (Resources.proto), NOT the binary AXML format used inside APKs.
 *
 * The generic decoder reads any protobuf message into a field-number-keyed
 * object.  ProtoXMLParser then walks that structure according to the
 * XmlNode / XmlElement / XmlAttribute schema to produce the same
 * { tag, attributes, children } tree that AXMLParser outputs.
 *
 * ── Proto wire types ──────────────────────────────
 *   0 = varint   1 = 64-bit   2 = length-delimited   5 = 32-bit
 *
 * ── AAPT2 schema (field numbers) ──────────────────
 *
 * XmlNode {
 *   element:1  XmlElement       (LEN)
 *   text:2     string           (LEN)
 * }
 * XmlElement {
 *   namespace_declaration:1[]  XmlNamespace  (LEN, repeated)
 *   namespace_uri:2            string        (LEN)
 *   name:3                     string        (LEN)
 *   attribute:4[]              XmlAttribute  (LEN, repeated)
 *   child:5[]                  XmlNode       (LEN, repeated)
 * }
 * XmlAttribute {
 *   namespace_uri:1   string   (LEN)
 *   name:2            string   (LEN)
 *   value:3           string   (LEN)
 *   resource_id:5     uint32   (VARINT)
 *   compiled_item:6   Item     (LEN)
 * }
 * XmlNamespace {
 *   prefix:1   string   (LEN)
 *   uri:2      string   (LEN)
 * }
 * Item {
 *   ref:1      Reference   (LEN)
 *   str:2      String      (LEN)
 *   raw_str:3  RawString   (LEN)
 *   prim:7     Primitive   (LEN)
 * }
 * Reference  { id:1 uint32 }
 * String     { value:1 string }
 * RawString  { value:1 string }
 * Primitive  {
 *   null_value:1   NullType   (LEN)
 *   float_value:3  float      (FIXED32)
 *   int_dec:6      int32      (VARINT)
 *   int_hex:7      uint32     (VARINT)
 *   boolean:8      bool       (VARINT)
 * }
 */

// ── Generic protobuf decoder ──────────────────────

class ProtoDecoder {
  /**
   * @param {ArrayBuffer} buffer  – backing buffer (shared across sub-decoders)
   * @param {number}      [start] – byte offset into buffer
   * @param {number}      [len]   – number of bytes to read
   */
  constructor(buffer, start, len) {
    this.buf = buffer;
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.pos = start || 0;
    this.end = this.pos + (len != null ? len : buffer.byteLength - this.pos);
  }

  /** Read all fields and return { fieldNumber: [ {wt, v}, … ] }. */
  readFields() {
    const fields = {};
    while (this.pos < this.end) {
      const tag = this._varint();
      const num = tag >>> 3;
      const wt = tag & 7;
      if (num === 0) break;

      let v;
      switch (wt) {
        case 0: v = this._varint(); break;
        case 1: v = this._fixed64(); break;
        case 2: {
          const n = this._varint();
          v = { off: this.pos, len: n };   // reference into original buffer
          this.pos += n;
          break;
        }
        case 5: v = this._fixed32(); break;
        default:
          // unknown wire type – can't skip safely, abort
          return fields;
      }
      (fields[num] || (fields[num] = [])).push({ wt, v });
    }
    return fields;
  }

  _varint() {
    let r = 0, s = 0;
    while (this.pos < this.end) {
      const b = this.bytes[this.pos++];
      if (s < 28) r |= (b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7;
    }
    return r >>> 0;
  }

  _fixed32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  _fixed64() {
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    return lo + hi * 0x100000000;
  }
}

// ── Proto-XML tree builder ────────────────────────

class ProtoXMLParser {
  constructor(buffer) {
    this.buf = buffer;       // ArrayBuffer
    this.namespaces = {};    // uri → prefix
  }

  /** Parse the proto-encoded XmlNode and return { tag, attributes, children }. */
  parse() {
    const fields = new ProtoDecoder(this.buf).readFields();
    return this._xmlNode(fields);
  }

  // decode a length-delimited field entry into sub-fields
  _sub(entry) {
    if (entry.wt !== 2) return {};
    return new ProtoDecoder(this.buf, entry.v.off, entry.v.len).readFields();
  }

  // read a string from a length-delimited field
  _str(fields, num) {
    const arr = fields[num];
    if (!arr || arr[0].wt !== 2) return null;
    const { off, len } = arr[0].v;
    if (len === 0) return '';
    return new TextDecoder().decode(new Uint8Array(this.buf, off, len));
  }

  // ── schema walkers ──

  _xmlNode(fields) {
    // field 1 = element (XmlElement)
    if (fields[1] && fields[1][0].wt === 2) {
      return this._xmlElement(this._sub(fields[1][0]));
    }
    return null;
  }

  _xmlElement(f) {
    // field 1 (repeated) = namespace declarations
    if (f[1]) {
      for (const ns of f[1]) {
        if (ns.wt !== 2) continue;
        const nsf = this._sub(ns);
        const prefix = this._str(nsf, 1);
        const uri = this._str(nsf, 2);
        if (prefix && uri) this.namespaces[uri] = prefix;
      }
    }

    const tag = this._str(f, 3) || '';
    const element = { tag, attributes: {}, children: [], _rawAttrs: [] };

    // field 4 (repeated) = attributes
    if (f[4]) {
      for (const a of f[4]) {
        if (a.wt !== 2) continue;
        const af = this._sub(a);

        const nsUri = this._str(af, 1);
        const name = this._str(af, 2);
        let value = this._str(af, 3);

        // field 6 = compiled_item (Item) – typed value overrides string
        if (af[6] && af[6][0].wt === 2) {
          const typed = this._item(this._sub(af[6][0]));
          if (typed !== undefined) value = typed;
        }

        const prefix = nsUri ? this.namespaces[nsUri] : null;
        const key = prefix ? `${prefix}:${name}` : name;
        element.attributes[key] = value;
        element._rawAttrs.push({ namespace: nsUri, name, value });
      }
    }

    // field 5 (repeated) = child XmlNodes
    if (f[5]) {
      for (const c of f[5]) {
        if (c.wt !== 2) continue;
        const child = this._xmlNode(this._sub(c));
        if (child) element.children.push(child);
      }
    }

    return element;
  }

  _item(f) {
    // field 1 = Reference { id:1 uint32 }
    if (f[1] && f[1][0].wt === 2) {
      const ref = this._sub(f[1][0]);
      const id = ref[1] ? ref[1][0].v : 0;
      return '@0x' + id.toString(16);
    }
    // field 2 = String { value:1 string }
    if (f[2] && f[2][0].wt === 2) {
      return this._str(this._sub(f[2][0]), 1);
    }
    // field 3 = RawString { value:1 string }
    if (f[3] && f[3][0].wt === 2) {
      return this._str(this._sub(f[3][0]), 1);
    }
    // field 7 = Primitive
    if (f[7] && f[7][0].wt === 2) {
      return this._primitive(this._sub(f[7][0]));
    }
    return undefined;
  }

  _primitive(f) {
    // int_decimal_value (field 6, varint)
    if (f[6] && f[6][0].wt === 0) return f[6][0].v;
    // int_hexadecimal_value (field 7, varint)
    if (f[7] && f[7][0].wt === 0) return f[7][0].v;
    // boolean_value (field 8, varint)
    if (f[8] && f[8][0].wt === 0) return f[8][0].v !== 0;
    // float_value (field 3, fixed32)
    if (f[3] && f[3][0].wt === 5) {
      const tmp = new ArrayBuffer(4);
      new DataView(tmp).setUint32(0, f[3][0].v);
      return new DataView(tmp).getFloat32(0);
    }
    // null_value (field 1)
    if (f[1]) return null;
    return undefined;
  }
}
