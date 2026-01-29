/**
 * Android APK parser.
 *
 * Uses JSZip (expected on window.JSZip) to extract the archive and the
 * AXMLParser (expected on window.AXMLParser) to decode AndroidManifest.xml.
 */
class APKParser {
  static async parse(file) {
    const zip = await JSZip.loadAsync(file);

    const info = {
      type: 'APK',
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
      totalFiles: Object.keys(zip.files).length,
    };

    // ── AndroidManifest.xml ──
    const manifestEntry = zip.file('AndroidManifest.xml');
    if (manifestEntry) {
      try {
        const buf = await manifestEntry.async('arraybuffer');
        const tree = new AXMLParser(buf).parse();
        this._extractManifest(tree, info);
      } catch (e) {
        info._manifestError = e.message;
      }
    }

    // ── App icon ──
    info.icon = await this._extractIcon(zip, info);

    // ── Signing ──
    const metaFiles = Object.keys(zip.files).filter(f => f.startsWith('META-INF/'));
    const certFile = metaFiles.find(f => /\.(RSA|DSA|EC)$/i.test(f));
    if (certFile) {
      info.signingInfo = {
        signed: true,
        certFile,
        signatureFiles: metaFiles.filter(f => /\.(SF|MF)$/i.test(f)),
      };
    }

    // ── Native libs ──
    const soFiles = Object.keys(zip.files).filter(f => f.startsWith('lib/') && f.endsWith('.so'));
    if (soFiles.length) {
      info.architectures = [...new Set(soFiles.map(f => f.split('/')[1]))];
    }

    // ── DEX count ──
    info.dexCount = Object.keys(zip.files).filter(f => f.endsWith('.dex')).length;

    return info;
  }

  // ── manifest extraction ──

  static _extractManifest(manifest, info) {
    if (!manifest || manifest.tag !== 'manifest') return;
    const a = manifest.attributes;

    info.package = a['package'] ?? null;
    info.versionCode = a['android:versionCode'] ?? null;
    info.versionName = a['android:versionName'] ?? null;

    const sdk = this._child(manifest, 'uses-sdk');
    if (sdk) {
      info.minSdkVersion = sdk.attributes['android:minSdkVersion'] ?? null;
      info.targetSdkVersion = sdk.attributes['android:targetSdkVersion'] ?? null;
    }

    info.permissions = this._children(manifest, 'uses-permission')
      .map(p => p.attributes['android:name'] || '')
      .filter(Boolean);

    const app = this._child(manifest, 'application');
    if (app) {
      info.appName = app.attributes['android:label'] ?? null;
      info.debuggable = app.attributes['android:debuggable'] === true;

      const iconAttr = app.attributes['android:icon'];
      if (typeof iconAttr === 'string' && !iconAttr.startsWith('@')) {
        info.iconPath = iconAttr;
      }

      info.activities = this._children(app, 'activity').map(a => ({
        name: a.attributes['android:name'] || '',
        isLauncher: this._isLauncher(a),
      }));

      info.services = this._children(app, 'service')
        .map(s => s.attributes['android:name'] || '')
        .filter(Boolean);

      info.receivers = this._children(app, 'receiver')
        .map(r => r.attributes['android:name'] || '')
        .filter(Boolean);
    }
  }

  static _isLauncher(activity) {
    return this._children(activity, 'intent-filter').some(f => {
      const hasMain = this._children(f, 'action')
        .some(a => a.attributes['android:name'] === 'android.intent.action.MAIN');
      const hasLauncher = this._children(f, 'category')
        .some(c => c.attributes['android:name'] === 'android.intent.category.LAUNCHER');
      return hasMain && hasLauncher;
    });
  }

  // ── icon extraction ──

  static async _extractIcon(zip, info) {
    // Try explicit path first
    if (info.iconPath) {
      const entry = zip.file(info.iconPath);
      if (entry) return URL.createObjectURL(await entry.async('blob'));
    }

    // Common icon locations, highest density first
    const candidates = [
      'res/mipmap-xxxhdpi-v4/ic_launcher.png',
      'res/mipmap-xxhdpi-v4/ic_launcher.png',
      'res/mipmap-xhdpi-v4/ic_launcher.png',
      'res/mipmap-hdpi-v4/ic_launcher.png',
      'res/mipmap-mdpi-v4/ic_launcher.png',
      'res/mipmap-xxxhdpi/ic_launcher.png',
      'res/mipmap-xxhdpi/ic_launcher.png',
      'res/mipmap-xhdpi/ic_launcher.png',
      'res/mipmap-hdpi/ic_launcher.png',
      'res/drawable-xxxhdpi-v4/ic_launcher.png',
      'res/drawable-xxhdpi-v4/ic_launcher.png',
      'res/drawable-xhdpi-v4/ic_launcher.png',
      'res/drawable-hdpi-v4/ic_launcher.png',
      'res/mipmap-xxxhdpi-v4/ic_launcher_round.png',
      'res/mipmap-xxhdpi-v4/ic_launcher_round.png',
      'res/mipmap-xxxhdpi/ic_launcher_round.png',
      'res/mipmap-xxhdpi/ic_launcher_round.png',
    ];

    for (const path of candidates) {
      const entry = zip.file(path);
      if (entry) {
        info.iconPath = path;
        return URL.createObjectURL(await entry.async('blob'));
      }
    }

    // Fallback: regex search
    const all = Object.keys(zip.files);
    const densityRank = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi'];
    const match = all
      .filter(f => /ic_launcher[^/]*\.png$/i.test(f))
      .sort((a, b) => {
        const ai = densityRank.findIndex(d => a.includes(d));
        const bi = densityRank.findIndex(d => b.includes(d));
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
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

  // ── tree helpers ──

  static _child(el, tag) {
    return el.children.find(c => c.tag === tag);
  }

  static _children(el, tag) {
    return el.children.filter(c => c.tag === tag);
  }
}
