(function (root) {
  'use strict';
  const byId = id => document.getElementById(id);
  function text(tag, value, className = '') {
    const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
  }
  function date(value) { return value ? new Date(value).toLocaleString() : 'Not recorded'; }
  function table(id, rows, columns, empty) {
    const body = byId(id);
    if (!rows.length) {
      const row = document.createElement('tr'), cell = text('td', empty, 'table-empty'); cell.colSpan = columns.length;
      row.append(cell); body.replaceChildren(row); return;
    }
    body.replaceChildren(...rows.map(item => {
      const row = document.createElement('tr');
      for (const column of columns) row.append(text('td', column(item)));
      return row;
    }));
  }

  function create({ api, onDenied }) {
    let generation = 0, controller = null, retry = null, stale = null, running = false, attempts = 0;
    const status = (label, state) => {
      byId('liveStatus').textContent = label; byId('liveStatus').dataset.state = state;
    };
    const clearConnection = () => {
      controller?.abort(); controller = null; clearTimeout(retry); clearTimeout(stale);
    };
    function render(snapshot) {
      for (const [key, value] of Object.entries(snapshot.counts)) {
        const node = document.querySelector(`[data-metric="${key}"]`); if (node) node.textContent = value.toLocaleString();
      }
      byId('lastUpdated').textContent = `Updated ${date(snapshot.generatedAt)}`;
      byId('projectLabel').textContent = snapshot.projectId || 'Project not identified';
      byId('environmentLabel').textContent = snapshot.projectId === 'claimextension-prod' ? 'Production'
        : snapshot.projectId === 'claimextension' ? 'Staging' : 'Test environment';
      const config = snapshot.config;
      byId('maintenanceValue').textContent = config.maintenanceMode ? 'Maintenance enabled' : 'Processing available';
      byId('minimumVersionValue').textContent = config.minimumSupportedVersion;
      byId('ruleModeValue').textContent = config.processingRulesMode;
      byId('ruleVersionValue').textContent = config.activeRuleVersion || 'Bundled extension rules';
      table('attentionRows', snapshot.attention, [x => x.name || x.email, x => x.organizationId, x => x.reason, x => date(x.expiresAt)], 'Nothing needs attention right now.');
      table('monitorUserRows', snapshot.users, [x => x.name || x.email, x => x.email, x => x.organizationId, x => x.status,
        x => x.licenseStatus, x => date(x.expiresAt)], 'No user records found.');
      const query = byId('monitorUserSearch').value.toLowerCase().trim();
      for (const row of byId('monitorUserRows').rows) row.hidden = !row.textContent.toLowerCase().includes(query);
      table('monitorOrganizationRows', snapshot.organizations, [x => x.name, x => x.status,
        x => `${x.users} / ${x.maximumUsers ?? 'Not set'}`, x => x.licenseStatus, x => date(x.expiresAt)], 'No organizations found.');
      table('monitorAuditRows', snapshot.audit, [x => date(x.timestamp), x => x.action, x => x.actor,
        x => x.organizationId || '—', x => x.extensionVersion || x.result || '—'], 'No server audit events recorded.');
      const versionList = byId('versionDistribution');
      versionList.replaceChildren(...snapshot.versions.map(item => {
        const row = text('div', '', 'version-row');
        const label = text('span', `v${item.version}`), bar = document.createElement('progress');
        bar.max = Math.max(1, snapshot.versionSample.users); bar.value = item.users;
        bar.setAttribute('aria-label', `${item.users} observed users on version ${item.version}`);
        row.append(label, bar, text('strong', String(item.users))); return row;
      }));
      if (!snapshot.versions.length) versionList.append(text('p', 'No extension version events recorded yet.', 'empty'));
      byId('versionSample').textContent = `Latest reported version per user in the most recent ${snapshot.versionSample.events} server events (maximum 100). ${snapshot.versionSample.users} users observed. This is a sample, not total installs or online presence.`;
      byId('feedbackValue').textContent = snapshot.feedback >= 100 ? '100+ open' : `${snapshot.feedback} open`;
      byId('monitorError').hidden = true;
    }
    async function connect(epoch) {
      if (!running || epoch !== generation || document.hidden) return;
      controller = new AbortController();
      const signal = controller.signal;
      status(attempts ? 'Reconnecting' : 'Connecting', 'connecting');
      const watchdog = () => {
        clearTimeout(stale);
        stale = setTimeout(() => { status('Connection stale', 'error'); controller?.abort(); }, 45000);
      };
      watchdog();
      try {
        await api.watchMonitor(signal, (event, payload) => {
          if (!running || epoch !== generation || signal.aborted) return;
          watchdog();
          if (event === 'snapshot') { render(payload); attempts = 0; status('Live', 'live'); }
          if (event === 'monitor-error') throw new Error(payload.code);
        });
      } catch (error) {
        if (!running || epoch !== generation) return;
        if (['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(error.message)) { stop(); onDenied(error); return; }
        byId('monitorError').hidden = false;
        byId('monitorError').textContent = error.message === 'MONITOR_NOT_DEPLOYED'
          ? 'Live monitoring is not deployed to this backend yet. Existing administration sections remain available.'
          : 'Live connection interrupted. Displayed values may be out of date; reconnecting automatically.';
      } finally {
        if (epoch === generation) clearTimeout(stale);
        if (running && epoch === generation && !document.hidden) {
          status('Reconnecting · data may be stale', 'error');
          retry = setTimeout(() => connect(epoch), Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
        }
      }
    }
    function stop() {
      running = false; ++generation; clearConnection(); status('Disconnected', 'offline');
      for (const node of document.querySelectorAll('[data-metric]')) node.textContent = '—';
      for (const id of ['attentionRows', 'monitorUserRows', 'monitorOrganizationRows', 'monitorAuditRows', 'versionDistribution']) byId(id).replaceChildren();
      for (const id of ['maintenanceValue', 'minimumVersionValue', 'ruleModeValue', 'ruleVersionValue', 'feedbackValue']) byId(id).textContent = '—';
      byId('lastUpdated').textContent = 'Waiting for the first backend snapshot';
      byId('versionSample').textContent = 'Version coverage will appear after the live feed connects.';
      byId('projectLabel').textContent = 'Verifying backend';
      byId('environmentLabel').textContent = 'Disconnected';
      byId('monitorError').hidden = true;
    }
    function start() { clearConnection(); running = true; attempts = 0; connect(++generation); }
    byId('reconnectMonitor').addEventListener('click', start);
    document.addEventListener('visibilitychange', () => {
      if (!running) return;
      ++generation; clearConnection();
      if (document.hidden) status('Paused while tab is hidden', 'offline'); else connect(generation);
    });
    root.addEventListener('pagehide', stop);
    return { start, stop };
  }
  root.ClaimSparkMonitor = Object.freeze({ create });
})(globalThis);
