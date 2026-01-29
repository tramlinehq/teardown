document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const loading = document.getElementById('loading');
  const results = document.getElementById('results');
  const errorDiv = document.getElementById('error');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  async function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['apk', 'aab', 'ipa'].includes(ext)) {
      return showError(`Unsupported file type ".${ext}". Drop an .apk, .aab, or .ipa file.`);
    }
    showLoading();
    try {
      const parsers = { apk: APKParser, aab: AABParser, ipa: IPAParser };
      showResults(await parsers[ext].parse(file));
    } catch (e) {
      console.error(e);
      showError(`Failed to parse ${file.name}: ${e.message}`);
    }
  }

  function showLoading() {
    loading.classList.remove('hidden');
    results.classList.add('hidden');
    errorDiv.classList.add('hidden');
    dropZone.classList.add('hidden');
  }

  function showError(msg) {
    loading.classList.add('hidden');
    results.classList.add('hidden');
    errorDiv.classList.remove('hidden');
    dropZone.classList.remove('hidden');
    errorDiv.textContent = msg;
  }

  function showResults(info) {
    loading.classList.add('hidden');
    dropZone.classList.remove('hidden');
    results.classList.remove('hidden');
    errorDiv.classList.add('hidden');

    results.innerHTML = info.type === 'IPA' ? renderIPA(info) : renderAndroid(info);

    const copyBtn = results.querySelector('[data-action="copy"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const clean = structuredClone(info);
        delete clean.icon;
        navigator.clipboard.writeText(JSON.stringify(clean, null, 2))
          .then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy JSON', 1500); });
      });
    }
  }

  // ── renderers ──

  const SDK_NAMES = {
    21:'Lollipop 5.0',22:'Lollipop 5.1',23:'Marshmallow 6.0',24:'Nougat 7.0',25:'Nougat 7.1',
    26:'Oreo 8.0',27:'Oreo 8.1',28:'Pie 9',29:'Android 10',30:'Android 11',
    31:'Android 12',32:'Android 12L',33:'Android 13',34:'Android 14',35:'Android 15',
  };

  function sdkLabel(v) {
    return v != null ? `API ${v}${SDK_NAMES[v] ? ' — ' + SDK_NAMES[v] : ''}` : null;
  }

  function renderAndroid(info) {
    const isAAB = info.type === 'AAB';
    const label = isAAB ? 'Android App Bundle' : 'Android APK';

    let h = '';
    if (info.icon) h += `<img class="result-icon" src="${info.icon}" alt="">`;
    h += `<h2>${esc(appName(info.appName, info.package))}</h2>`;
    h += `<p class="result-meta">${esc(label)}`;
    if (info.debuggable) h += ' &middot; <strong>Debuggable</strong>';
    h += '</p>';

    h += '<table>';
    h += row('Package', info.package);
    h += row('Version Name', info.versionName);
    h += row('Version Code', info.versionCode);
    h += row('Min SDK', sdkLabel(info.minSdkVersion));
    h += row('Target SDK', sdkLabel(info.targetSdkVersion));
    h += row('File Size', fmtSize(info.fileSize));
    h += row('Files', info.totalFiles);
    h += row('DEX Files', info.dexCount);
    if (info.architectures) h += row('Architectures', info.architectures.join(', '));
    h += row('Signed', info.signingInfo ? 'Yes' : 'No');
    h += '</table>';

    if (isAAB && info.modules?.length) {
      h += `<h3>Modules</h3><ul>${info.modules.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`;
    }

    if (info.permissions.length) {
      h += `<h3>Permissions (${info.permissions.length})</h3>`;
      h += `<ul>${info.permissions.map(p => `<li>${esc(p.replace(/^android\.permission\./, ''))}</li>`).join('')}</ul>`;
    }

    const launcher = info.activities.find(a => a.isLauncher);
    if (launcher) {
      h += `<h3>Launcher Activity</h3><p><code>${esc(launcher.name)}</code></p>`;
    }

    if (info.services.length) {
      h += `<h3>Services (${info.services.length})</h3>`;
      h += `<ul>${info.services.map(s => `<li>${esc(shortName(s, info.package))}</li>`).join('')}</ul>`;
    }
    if (info.receivers.length) {
      h += `<h3>Receivers (${info.receivers.length})</h3>`;
      h += `<ul>${info.receivers.map(r => `<li>${esc(shortName(r, info.package))}</li>`).join('')}</ul>`;
    }

    h += '<button data-action="copy">Copy JSON</button>';
    return h;
  }

  function renderIPA(info) {
    let h = '';
    if (info.icon) h += `<img class="result-icon" src="${info.icon}" alt="">`;
    h += `<h2>${esc(info.displayName || info.appName || info.bundleId || 'Unknown')}</h2>`;
    h += '<p class="result-meta">iOS IPA</p>';

    h += '<table>';
    h += row('Bundle ID', info.bundleId);
    h += row('App Name', info.appName);
    if (info.displayName && info.displayName !== info.appName) h += row('Display Name', info.displayName);
    h += row('Version', info.version);
    h += row('Build', info.buildNumber);
    h += row('Min iOS', info.minOSVersion);
    h += row('Devices', info.deviceFamilies.join(', ') || null);
    h += row('Platforms', info.supportedPlatforms.join(', ') || null);
    h += row('File Size', fmtSize(info.fileSize));
    h += row('Files', info.totalFiles);
    h += '</table>';

    const prov = info.provisioningInfo;
    if (prov) {
      h += '<h3>Provisioning Profile</h3><table>';
      h += row('Name', prov.name);
      h += row('Team', prov.teamName);
      h += row('Team ID', prov.teamId);
      h += row('App ID Name', prov.appIdName);
      h += row('Xcode Managed', prov.isXcodeManaged ? 'Yes' : 'No');
      if (prov.creationDate) h += row('Created', fmtDate(prov.creationDate));
      if (prov.expirationDate) h += row('Expires', fmtDate(prov.expirationDate));
      if (prov.provisionedDevices) h += row('Provisioned Devices', prov.provisionedDevices);
      h += '</table>';

      if (prov.entitlements && Object.keys(prov.entitlements).length) {
        h += '<h3>Entitlements</h3>';
        h += `<ul>${Object.keys(prov.entitlements).map(k => `<li>${esc(k)}</li>`).join('')}</ul>`;
      }
    }

    if (info.frameworks?.length) {
      h += `<h3>Frameworks (${info.frameworks.length})</h3>`;
      h += `<ul>${info.frameworks.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`;
    }

    if (info.requiredCapabilities) {
      const caps = Array.isArray(info.requiredCapabilities) ? info.requiredCapabilities : Object.keys(info.requiredCapabilities);
      if (caps.length) {
        h += `<h3>Required Capabilities</h3><ul>${caps.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`;
      }
    }

    if (info.backgroundModes?.length) {
      h += `<h3>Background Modes</h3><ul>${info.backgroundModes.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`;
    }

    h += '<button data-action="copy">Copy JSON</button>';
    return h;
  }

  // ── helpers ──

  function row(label, value) {
    const display = value != null ? String(value) : 'N/A';
    const isRef = typeof value === 'string' && value.startsWith('@0x');
    const cls = isRef ? ' class="ref"' : '';
    const extra = isRef ? ' (resource ref)' : '';
    return `<tr><th>${esc(label)}</th><td${cls}>${esc(display)}${extra}</td></tr>`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtDate(d) {
    try { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return String(d); }
  }

  function appName(name, pkg) {
    if (name && typeof name === 'string' && !name.startsWith('@')) return name;
    return pkg || 'Unknown App';
  }

  function shortName(full, pkg) {
    if (pkg && full.startsWith(pkg)) return full.slice(pkg.length);
    return full;
  }

  function esc(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = String(s);
    return el.innerHTML;
  }
});
