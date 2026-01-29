/**
 * iOS IPA parser.
 *
 * Uses JSZip to extract the archive, BPlistParser for binary plists,
 * and the browser DOMParser for XML plists.
 */
class IPAParser {
  static async parse(file) {
    const zip = await JSZip.loadAsync(file);

    const info = {
      type: 'IPA',
      fileName: file.name,
      fileSize: file.size,
      bundleId: null,
      appName: null,
      displayName: null,
      version: null,
      buildNumber: null,
      minOSVersion: null,
      deviceFamilies: [],
      supportedPlatforms: [],
      icon: null,
      iconPath: null,
      hasProvisioning: false,
      provisioningInfo: null,
      frameworks: null,
      requiredCapabilities: null,
      backgroundModes: null,
      totalFiles: Object.keys(zip.files).length,
    };

    // Locate the .app bundle inside Payload/
    const files = Object.keys(zip.files);
    const appDir = files.find(f => /^Payload\/[^/]+\.app\/$/i.test(f));
    if (!appDir) throw new Error('No .app bundle found inside IPA');

    // ── Info.plist ──
    const plistEntry = zip.file(appDir + 'Info.plist');
    let iconFileNames = [];
    if (plistEntry) {
      try {
        const buf = await plistEntry.async('arraybuffer');
        const plist = this._parsePlist(buf);
        iconFileNames = this._extractPlistInfo(plist, info);
      } catch (e) {
        info._plistError = e.message;
      }
    }

    // ── Icon ──
    info.icon = await this._extractIcon(zip, appDir, iconFileNames, files);

    // ── Provisioning profile ──
    const provEntry = zip.file(appDir + 'embedded.mobileprovision');
    if (provEntry) {
      info.hasProvisioning = true;
      try {
        const buf = await provEntry.async('arraybuffer');
        info.provisioningInfo = this._parseProvisioning(buf);
      } catch (_) { /* best-effort */ }
    }

    // ── Frameworks ──
    const fwPrefix = appDir + 'Frameworks/';
    const fws = files
      .filter(f => f.startsWith(fwPrefix) && f.endsWith('.framework/'))
      .map(f => f.slice(fwPrefix.length).replace(/\.framework\/$/, ''));
    if (fws.length) info.frameworks = fws;

    return info;
  }

  // ── plist parsing ──

  static _parsePlist(buffer) {
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(...bytes.slice(0, 6));
    if (magic === 'bplist') return new BPlistParser(buffer).parse();

    const text = new TextDecoder('utf-8').decode(bytes);
    if (text.includes('<plist')) return this._parseXMLPlist(text);

    throw new Error('Unknown plist format');
  }

  static _parseXMLPlist(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.querySelector('plist');
    if (!root || !root.children[0]) throw new Error('Empty plist');
    return this._xmlNode(root.children[0]);
  }

  static _xmlNode(node) {
    switch (node.tagName) {
      case 'dict': {
        const obj = {};
        const kids = Array.from(node.children);
        for (let i = 0; i < kids.length; i += 2) {
          obj[kids[i].textContent] = this._xmlNode(kids[i + 1]);
        }
        return obj;
      }
      case 'array':
        return Array.from(node.children).map(c => this._xmlNode(c));
      case 'string': return node.textContent;
      case 'integer': return parseInt(node.textContent, 10);
      case 'real': return parseFloat(node.textContent);
      case 'true': return true;
      case 'false': return false;
      case 'date': return new Date(node.textContent);
      case 'data': return atob(node.textContent.trim());
      default: return node.textContent;
    }
  }

  // ── plist info extraction (returns icon file name hints) ──

  static _extractPlistInfo(plist, info) {
    info.bundleId = plist.CFBundleIdentifier ?? null;
    info.appName = plist.CFBundleName ?? null;
    info.displayName = plist.CFBundleDisplayName ?? null;
    info.version = plist.CFBundleShortVersionString ?? null;
    info.buildNumber = plist.CFBundleVersion ?? null;
    info.minOSVersion = plist.MinimumOSVersion ?? null;
    info._executableName = plist.CFBundleExecutable ?? null;

    const families = plist.UIDeviceFamily || [];
    const familyNames = { 1: 'iPhone', 2: 'iPad', 3: 'Apple TV', 4: 'Apple Watch' };
    info.deviceFamilies = families.map(f => familyNames[f] || `Unknown (${f})`);

    info.supportedPlatforms = plist.CFBundleSupportedPlatforms || [];

    if (plist.UIRequiredDeviceCapabilities) {
      info.requiredCapabilities = plist.UIRequiredDeviceCapabilities;
    }
    if (plist.UIBackgroundModes) {
      info.backgroundModes = plist.UIBackgroundModes;
    }

    // Gather icon file name hints
    const names = [];
    const icons = plist.CFBundleIcons;
    if (icons) {
      const primary = icons.CFBundlePrimaryIcon;
      if (primary && primary.CFBundleIconFiles) names.push(...primary.CFBundleIconFiles);
    }
    if (plist.CFBundleIconFiles) names.push(...plist.CFBundleIconFiles);
    return names;
  }

  // ── icon extraction ──

  static async _extractIcon(zip, appDir, hints, allFiles) {
    // Build search list: plist hints (with @2x/@3x variants) + known names
    const search = [];
    for (const h of hints) {
      search.push(h + '@3x.png', h + '@2x.png', h + '.png');
    }
    search.push(
      'AppIcon60x60@3x.png',
      'AppIcon60x60@2x.png',
      'AppIcon76x76@2x~ipad.png',
      'AppIcon76x76@2x.png',
      'AppIcon76x76.png',
      'AppIcon40x40@3x.png',
      'AppIcon40x40@2x.png',
      'Icon-60@3x.png',
      'Icon-60@2x.png',
      'Icon@2x.png',
      'Icon.png',
    );

    for (const name of search) {
      const entry = zip.file(appDir + name);
      if (entry) {
        const url = await this._loadIconEntry(entry);
        if (url) return url;
      }
    }

    // Regex fallback
    const match = allFiles
      .filter(f => f.startsWith(appDir) && /AppIcon.*\.png$/i.test(f))
      .sort((a, b) => {
        // prefer @3x over @2x over plain
        const rank = s => (s.includes('@3x') ? 0 : s.includes('@2x') ? 1 : 2);
        return rank(a) - rank(b);
      })[0];

    if (match) {
      const entry = zip.file(match);
      if (entry) {
        const url = await this._loadIconEntry(entry);
        if (url) return url;
      }
    }

    return null;
  }

  /**
   * Extract a ZIP entry as a displayable icon blob URL.
   * Handles Apple CgBI-crushed PNGs transparently.
   */
  static async _loadIconEntry(entry) {
    try {
      const data = await entry.async('uint8array');
      const blob = await CrushedPNG.toBlob(data);
      return URL.createObjectURL(blob);
    } catch {
      // Last resort: let the browser try the raw bytes
      try {
        return URL.createObjectURL(await entry.async('blob'));
      } catch {
        return null;
      }
    }
  }

  // ── provisioning profile ──

  static _parseProvisioning(buffer) {
    // embedded.mobileprovision is CMS-signed; the plist XML sits inside it.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer));
    const start = text.indexOf('<?xml');
    const end = text.indexOf('</plist>');
    if (start < 0 || end < 0) return null;

    const plist = this._parseXMLPlist(text.substring(start, end + '</plist>'.length));
    return {
      name: plist.Name ?? null,
      teamName: plist.TeamName ?? null,
      teamId: plist.TeamIdentifier?.[0] ?? null,
      appIdName: plist.AppIDName ?? null,
      isXcodeManaged: plist.IsXcodeManaged ?? false,
      creationDate: plist.CreationDate ?? null,
      expirationDate: plist.ExpirationDate ?? null,
      provisionedDevices: plist.ProvisionedDevices?.length ?? 0,
      entitlements: plist.Entitlements ?? {},
    };
  }
}
