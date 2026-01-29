/**
 * Android App Bundle (AAB) parser.
 *
 * AABs are ZIP archives with a module-based layout:
 *   base/manifest/AndroidManifest.xml   (proto-XML – NOT the binary AXML used in APKs)
 *   base/dex/classes*.dex
 *   base/res/                           (resources, same density folders as APK)
 *   base/lib/                           (native .so libraries)
 *   base/assets/
 *   base/resources.pb                   (protobuf – compiled resources)
 *   <feature_module>/manifest/...       (optional dynamic-feature modules)
 *   BundleConfig.pb
 *   META-INF/                           (signing)
 *
 * The manifest is serialised with the AAPT2 proto schema (XmlNode message),
 * so we use ProtoXMLParser.  We fall back to AXMLParser for edge cases.
 *
 * Reuses APKParser's static helpers for manifest extraction and tree queries.
 */
class AABParser {
  static async parse(file) {
    const zip = await JSZip.loadAsync(file);
    const allFiles = Object.keys(zip.files);

    const info = {
      type: 'AAB',
      fileName: file.name,
      fileSize: file.size,
      package: null,
      appName: null,
      versionCode: null,
      versionName: null,
      minSdkVersion: null,
      targetSdkVersion: null,
      permissions: [],
      activities: [],
      services: [],
      receivers: [],
      icon: null,
      iconPath: null,
      signingInfo: null,
      debuggable: false,
      architectures: null,
      dexCount: 0,
      modules: [],
      totalFiles: allFiles.length,
    };

    // ── Detect modules ──
    const moduleDirs = new Set();
    for (const f of allFiles) {
      const match = f.match(/^([^/]+)\/manifest\/AndroidManifest\.xml$/);
      if (match) moduleDirs.add(match[1]);
    }
    info.modules = [...moduleDirs].sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));

    // ── AndroidManifest.xml (base module) ──
    const manifestEntry = zip.file('base/manifest/AndroidManifest.xml');
    if (manifestEntry) {
      const buf = await manifestEntry.async('arraybuffer');
      const tree = this._parseManifestBuffer(buf);
      if (tree) {
        APKParser._extractManifest(tree, info);
      }
    }

    // ── App icon (inside base/res/) ──
    info.icon = await this._extractIcon(zip, allFiles, info);

    // ── Signing ──
    const metaFiles = allFiles.filter(f => f.startsWith('META-INF/'));
    const certFile = metaFiles.find(f => /\.(RSA|DSA|EC)$/i.test(f));
    if (certFile) {
      info.signingInfo = {
        signed: true,
        certFile,
        signatureFiles: metaFiles.filter(f => /\.(SF|MF)$/i.test(f)),
      };
    }

    // ── Native libs (base/lib/<arch>/*.so) ──
    const soFiles = allFiles.filter(f => /^base\/lib\/[^/]+\/.*\.so$/.test(f));
    if (soFiles.length) {
      info.architectures = [...new Set(soFiles.map(f => f.split('/')[2]))];
    }

    // ── DEX count (base/dex/ + feature modules) ──
    info.dexCount = allFiles.filter(f => f.endsWith('.dex')).length;

    return info;
  }

  /**
   * Detect format and parse the manifest buffer.
   *
   * AXML starts with uint16-LE 0x0003 (RES_XML_TYPE).
   * Proto-XML starts with a field tag varint — first byte is typically
   * 0x0A (field 1, wire type 2 = XmlNode.element).
   *
   * We try proto first (the normal AAB case), then fall back to AXML.
   */
  static _parseManifestBuffer(buf) {
    const firstWord = new DataView(buf).getUint16(0, true);
    const isAXML = firstWord === 0x0003;

    if (!isAXML) {
      // proto format (standard AAB)
      try {
        return new ProtoXMLParser(buf).parse();
      } catch (_) { /* fall through */ }
    }

    // AXML format (legacy / edge case)
    try {
      return new AXMLParser(buf).parse();
    } catch (_) { /* fall through */ }

    return null;
  }

  // ── icon extraction (paths prefixed with base/res/) ──

  static async _extractIcon(zip, allFiles, info) {
    // Try explicit path if set by manifest parsing
    if (info.iconPath) {
      const prefixed = 'base/' + info.iconPath;
      const entry = zip.file(prefixed);
      if (entry) {
        info.iconPath = prefixed;
        return URL.createObjectURL(await entry.async('blob'));
      }
    }

    const densities = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi'];
    const names = ['ic_launcher.png', 'ic_launcher_round.png'];
    const buckets = ['mipmap', 'drawable'];

    // Build candidate list in priority order
    const candidates = [];
    for (const name of names) {
      for (const d of densities) {
        for (const b of buckets) {
          candidates.push(`base/res/${b}-${d}-v4/${name}`);
          candidates.push(`base/res/${b}-${d}/${name}`);
        }
      }
    }

    for (const path of candidates) {
      const entry = zip.file(path);
      if (entry) {
        info.iconPath = path;
        return URL.createObjectURL(await entry.async('blob'));
      }
    }

    // Regex fallback
    const match = allFiles
      .filter(f => f.startsWith('base/res/') && /ic_launcher[^/]*\.png$/i.test(f))
      .sort((a, b) => {
        const rank = s => {
          const idx = densities.findIndex(d => s.includes(d));
          return idx < 0 ? 99 : idx;
        };
        return rank(a) - rank(b);
      })[0];

    if (match) {
      const entry = zip.file(match);
      if (entry) {
        info.iconPath = match;
        return URL.createObjectURL(await entry.async('blob'));
      }
    }

    return null;
  }
}
