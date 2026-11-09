const root = document.getElementById('app');
let state = null;
let reportEnvelope = null;
let tab = 'overview';
let showSwitcher = false;
let selectedShiftId = null;
let draftCode = '';
let preview = null;
let busy = false;
let refreshing = false;
let flash = null;

const icon = (name, size = 20) => {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chart: '<path d="M3 19h18M6 16V9m6 7V5m6 11v-4"/>',
    laptop: '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20M9 20l1-4m4 4-1-4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
    alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 9v5m0 3h.01"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    coffee: '<path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm13 1h2a3 3 0 1 1 0 6h-2M7 3v2m5-2v2"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const clockTime = (ms) => ms == null ? '—' : new Date(ms).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
const dateTime = (ms) => ms == null ? '—' : new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
const span = (ms) => {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
};
const shortId = (value) => value ? `${String(value).slice(0, 8)}…` : '—';

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const nextState = await api('/api/demo/state');
    const nextReport = nextState.worker
      ? await api(`/api/demo/report${selectedShiftId ? `?shiftId=${encodeURIComponent(selectedShiftId)}` : ''}`)
      : null;
    state = nextState;
    reportEnvelope = nextReport;
    if (selectedShiftId && nextReport && !nextReport.shifts.some((item) => item.id === selectedShiftId)) selectedShiftId = null;
    if (force || !document.activeElement?.matches('input, select')) render();
  } catch (error) {
    flash = { type: 'error', message: `Cannot reach the local demo server: ${error.message}` };
    render();
  } finally { refreshing = false; }
}

async function action(task, success) {
  if (busy) return;
  busy = true;
  render();
  try {
    await task();
    flash = success ? { type: 'success', message: success } : null;
  } catch (error) {
    flash = { type: 'error', message: error.message };
  } finally {
    busy = false;
    await refresh(true);
  }
}

function brand() {
  return `<a class="brand" href="/" aria-label="MoonBridge Activity home">
    <span class="brand-mark"><img src="/moonbridge-logo.png" alt="" /></span>
    <span class="brand-name">MOONBRIDGE<small>ACTIVITY STUDIO</small></span>
  </a>`;
}

function sidebar() {
  return `<aside class="sidebar">
    ${brand()}
    <div class="sidebar-section-label">WORKSPACE</div>
    <nav class="nav" aria-label="Main navigation">
      <button class="nav-item ${tab === 'overview' ? 'active' : ''}" data-tab="overview">${icon('grid')}<span>Overview</span></button>
      <button class="nav-item ${tab === 'timecard' ? 'active' : ''}" data-tab="timecard">${icon('clock')}<span>My timecard</span></button>
      <button class="nav-item ${tab === 'report' ? 'active' : ''}" data-tab="report">${icon('chart')}<span>Activity report</span></button>
    </nav>
    <div class="sidebar-bottom">
      <div class="local-card"><span class="local-orb"></span><div><strong>Local demonstration</strong><small>Synthetic workers · SQLite on this PC</small></div></div>
      <div class="sidebar-foot">MoonBridge Activity <span>v0.1</span></div>
    </div>
  </aside>`;
}

function topbar() {
  const worker = state?.worker;
  return `<header class="topbar">
    <div class="topbar-left"><span class="crumb">MOONBRIDGE</span>${icon('chevron', 15)}<span>${tab === 'report' ? 'Activity report' : tab === 'timecard' ? 'My timecard' : 'Overview'}</span></div>
    <div class="topbar-actions">
      <span class="environment-pill"><span class="environment-dot"></span>LOCAL ONLY</span>
      ${worker ? `<button class="worker-switch" data-action="switch-worker" aria-label="Switch synthetic worker"><span class="avatar avatar-${esc(worker.id)}">${esc(worker.initials)}</span><span><strong>${esc(worker.name)}</strong><small>Switch worker</small></span>${icon('chevron', 15)}</button>` : ''}
    </div>
  </header>`;
}

function notice() {
  if (!flash) return '';
  return `<div class="flash ${flash.type}" role="status">${icon(flash.type === 'success' ? 'check' : 'alert', 18)}<span>${esc(flash.message)}</span><button data-action="dismiss" aria-label="Dismiss notification">×</button></div>`;
}

function workerPicker() {
  return `<section class="picker-wrap">
    <div class="picker-intro"><span class="eyebrow">A PRIVATE, LOCAL WALKTHROUGH</span><h1>Choose a worker to begin</h1>
    <p>Explore the real desktop-to-server flow with synthetic profiles. Each worker has a separate shift and activity history.</p></div>
    <div class="worker-grid">${(state?.workers || []).map((worker) => `<button class="worker-card" data-worker="${esc(worker.id)}">
      <span class="avatar avatar-lg avatar-${esc(worker.id)}">${esc(worker.initials)}</span><span class="worker-card-copy"><strong>${esc(worker.name)}</strong><small>${esc(worker.title)}</small></span>${icon('arrow', 20)}</button>`).join('')}</div>
    <div class="picker-note">${icon('shield', 19)}<span>All names, shifts, and reports are local synthetic data. Nothing connects to MoonBridge production.</span></div>
  </section>`;
}

function workerStatus() {
  return `<div class="worker-status-row">${state.workers.map((worker) => `<div class="mini-worker">
    <span class="avatar avatar-${esc(worker.id)}">${esc(worker.initials)}</span><span><strong>${esc(worker.name)}</strong><small>${worker.clockedIn ? worker.paired ? 'Paired · on shift' : 'On shift' : 'Off shift'}</small></span><i class="mini-dot ${worker.clockedIn ? 'on' : ''}"></i>
  </div>`).join('')}</div>`;
}

function metric(label, value, note, tone, metricIcon) {
  return `<div class="metric-card ${tone}"><div class="metric-head"><span>${esc(label)}</span><span class="metric-icon">${icon(metricIcon, 18)}</span></div><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
}

function metricGrid() {
  const summary = reportEnvelope?.report?.summaryMs || { active: 0, idle: 0, break: 0, unverified: 0 };
  return `<div class="metric-grid">
    ${metric('Active input', span(summary.active), 'Keyboard or mouse activity', 'active-tone', 'play')}
    ${metric('Idle input', span(summary.idle), 'Five-minute threshold', 'idle-tone', 'pause')}
    ${metric('On break', span(summary.break), 'From the timecard', 'break-tone', 'coffee')}
    ${metric('Unverified', span(summary.unverified), 'No accepted interval', 'unknown-tone', 'alert')}
  </div>`;
}

function connectionCard() {
  const offline = state.desktopOffline;
  return `<section class="card connection-card">
    <div class="card-heading"><div><span class="eyebrow">DEMO CONTROL</span><h2>Desktop connection</h2></div><span class="connection-pill ${offline ? 'disconnected' : ''}"><span></span>${offline ? 'Paused' : 'Connected'}</span></div>
    <p class="card-copy">${offline ? 'Desktop API connection is interrupted. The Windows app queues intervals locally.' : 'Desktop API requests are available on this computer.'}</p>
    <button class="button ${offline ? 'primary' : 'secondary'} full" data-action="network" ${busy ? 'disabled' : ''}>${icon(offline ? 'wifi' : 'pause', 17)}${offline ? 'Reconnect desktop' : 'Simulate network outage'}</button>
    <p class="fine-print">The web dashboard stays available while the desktop connection is paused.</p>
  </section>`;
}

function shiftCard(compact = false) {
  const worker = state.worker;
  const shift = state.shift;
  const activeBreak = state.activeBreak;
  const status = !shift ? 'Off shift' : activeBreak ? activeBreak.kind === 'lunch' ? 'On lunch' : 'On break' : 'On shift';
  return `<section class="card shift-card ${compact ? 'compact' : ''}">
    <div class="card-heading"><div><span class="eyebrow">CURRENT TIMECARD</span><h2>${esc(worker.name)}’s shift</h2></div><span class="state-chip ${shift ? activeBreak ? 'break-state' : 'live' : ''}"><span></span>${status}</span></div>
    ${shift ? `<div class="shift-display"><div><span>Clocked in</span><strong>${clockTime(shift.started_ms)}</strong><small>Philippine time</small></div><div class="shift-divider"></div><div><span>Desktop pairing</span><strong class="pairing-value">${state.pairing ? 'Connected' : 'Waiting'}</strong><small>${state.pairing ? esc(shortId(state.pairing.device_id)) : 'Pair this shift'}</small></div></div>`
      : `<div class="empty-shift">${icon('clock', 27)}<strong>No open shift</strong><span>Clock in to make this worker eligible for desktop pairing.</span></div>`}
    <div class="shift-actions">${!shift
      ? `<button class="button primary" data-action="clock-in" ${busy ? 'disabled' : ''}>${icon('play', 16)}Clock in</button>`
      : activeBreak
        ? `<button class="button primary" data-action="break-end" ${busy ? 'disabled' : ''}>${icon('play', 16)}End ${activeBreak.kind}</button><button class="button subtle" data-action="clock-out" ${busy ? 'disabled' : ''}>Clock out</button>`
        : `<button class="button secondary" data-action="break-start" ${busy ? 'disabled' : ''}>${icon('coffee', 17)}Start break</button><button class="button subtle" data-action="clock-out" ${busy ? 'disabled' : ''}>Clock out</button>`}</div>
  </section>`;
}

function pairCard() {
  const shift = state.shift;
  const pairing = state.pairing;
  return `<section class="card pair-card" id="pairing">
    <div class="card-heading"><div><span class="eyebrow">WINDOWS COMPANION</span><h2>Pair MoonBridge Activity</h2></div><span class="card-icon">${icon('laptop', 20)}</span></div>
    ${pairing ? `<div class="paired-banner"><span class="paired-check">${icon('check', 21)}</span><div><strong>Desktop paired to this shift</strong><small>Device ${esc(pairing.device_id)} · since ${clockTime(pairing.created_ms)}</small></div></div>
      <p class="card-copy">Activity intervals from this computer will appear in the report as they arrive.</p>
      <a class="button secondary full" href="moonbridge://open">${icon('laptop', 17)}Open MoonBridge Activity</a>`
      : `<p class="card-copy">${shift ? 'Generate a code in the desktop app, then enter it here to link this computer to the open shift.' : 'Clock in first. Then generate a pairing code in the desktop app.'}</p>
      <a class="button secondary full" href="moonbridge://open">${icon('laptop', 17)}Open MoonBridge Activity</a>
      <form id="pair-form" class="pair-form"><label for="pair-code">One-time desktop code</label><div class="pair-form-row"><input id="pair-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" value="${esc(draftCode)}" ${shift ? '' : 'disabled'} /><button class="button primary" type="submit" ${!shift || busy ? 'disabled' : ''}>Check code</button></div></form>
      ${preview ? `<div class="confirm-device"><span class="confirm-label">CONFIRM THIS COMPUTER</span><strong>${esc(preview.deviceId)}</strong><small>Code expires at ${clockTime(preview.expiresAt)} · ${esc(state.worker.name)}’s open shift</small><button class="button primary full" data-action="approve" ${busy ? 'disabled' : ''}>${icon('link', 17)}Approve pairing</button></div>` : ''}`}
  </section>`;
}

function walkthrough() {
  const steps = [
    ['01', 'Clock in', 'An open shift establishes the worker identity.', !!state.shift],
    ['02', 'Pair desktop', 'Approve the one-time code in this web app.', !!state.pairing],
    ['03', 'Review activity', 'The Windows app uploads input intervals to this local database.', (reportEnvelope?.report?.eventCount || 0) > 0],
  ];
  return `<section class="card walkthrough"><div class="card-heading"><div><span class="eyebrow">DEMO FLOW</span><h2>How it connects</h2></div></div>
    <div class="step-list">${steps.map(([number, label, detail, done]) => `<div class="step"><span class="step-number ${done ? 'done' : ''}">${done ? icon('check', 15) : number}</span><div><strong>${label}</strong><small>${detail}</small></div></div>`).join('')}</div>
  </section>`;
}

function overview() {
  const worker = state.worker;
  return `<div class="page overview-page"><div class="page-lead"><div><span class="eyebrow">ACTIVITY OVERVIEW</span><h1>Good to see you, ${esc(worker.name.split(' ')[0])}.</h1><p>Clock, connect, and review the activity behind this shift.</p></div><div class="lead-actions"><button class="button secondary" data-tab="report">View activity report ${icon('arrow', 17)}</button></div></div>
    <div class="hero-strip"><div class="hero-copy"><span class="hero-kicker">MOONBRIDGE ACTIVITY</span><h2>One shift. One verified desktop.</h2><p>The local desktop app connects input activity to the worker who approved this pairing.</p></div><div class="hero-art" aria-hidden="true"><div class="hero-ring ring-one"></div><div class="hero-ring ring-two"></div><div class="hero-signal">${icon('chart', 49)}</div></div></div>
    ${metricGrid()}
    <div class="content-grid"><div class="content-main">${shiftCard()}${pairCard()}</div><div class="content-side">${connectionCard()}${walkthrough()}</div></div>
    <div class="section-heading"><div><span class="eyebrow">SHARED COMPUTER</span><h2>Synthetic workers</h2></div><button class="text-button" data-action="switch-worker">Switch worker ${icon('arrow', 16)}</button></div>${workerStatus()}
  </div>`;
}

function timecard() {
  return `<div class="page"><div class="page-lead"><div><span class="eyebrow">MY TIMECARD</span><h1>Clock and pairing</h1><p>Use the same worker identity for the web shift and the Windows companion.</p></div></div>
    <div class="content-grid"><div class="content-main">${shiftCard()}${pairCard()}</div><div class="content-side">${walkthrough()}${connectionCard()}</div></div>
    <div class="privacy-note">${icon('shield', 20)}<span>The desktop records input activity intervals only. A gap in coverage remains unverified; it is never assumed to be idle.</span></div>
  </div>`;
}

function timeline() {
  const report = reportEnvelope?.report;
  if (!report) return `<div class="empty-report">${icon('chart', 34)}<strong>No shift to report yet</strong><span>Clock in to begin a local activity record.</span></div>`;
  const total = Object.values(report.summaryMs).reduce((sum, value) => sum + value, 0);
  const colors = { active: 'Active', idle: 'Idle', break: 'Break', unverified: 'Unverified' };
  const visible = report.timeline.filter((item) => item.durationMs > 0);
  let position = 0;
  const bars = visible.map((item) => {
    const width = total ? item.durationMs / total * 1000 : 0;
    const rect = `<rect class="bar-${item.kind}" x="${position}" y="0" width="${width}" height="23"><title>${colors[item.kind]} · ${span(item.durationMs)}</title></rect>`;
    position += width;
    return rect;
  }).join('');
  return `<div class="timeline"><div class="timeline-caption"><strong>Shift coverage</strong><span>${clockTime(report.shift.startedMs)} – ${report.shift.endedMs ? clockTime(report.shift.endedMs) : 'Now'} · Philippine time</span></div>
    <svg class="timeline-bar" viewBox="0 0 1000 23" preserveAspectRatio="none" role="img" aria-label="Activity coverage: ${Object.entries(report.summaryMs).map(([kind, ms]) => `${kind} ${span(ms)}`).join(', ')}">${bars}</svg>
    <div class="legend">${Object.entries(colors).map(([kind, label]) => `<span><i class="legend-dot ${kind}"></i>${label}</span>`).join('')}</div></div>`;
}

function eventRows() {
  const events = reportEnvelope?.report?.recentEvents || [];
  if (!events.length) return `<div class="table-empty">No desktop intervals have arrived for this shift.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Event</th><th>Time</th><th>Duration</th><th>Received</th><th>Upload delay</th><th>Source</th></tr></thead><tbody>${events.map((event) => `<tr><td><span class="event-badge ${event.kind}"><i></i>${event.kind}</span></td><td>${clockTime(event.startMs)} – ${clockTime(event.endMs)}</td><td>${span(event.endMs - event.startMs)}</td><td>${clockTime(event.receivedMs)}</td><td>${span(event.uploadDelayMs)}</td><td>${event.source === 'sample' ? 'Sample' : 'Desktop'}</td></tr>`).join('')}</tbody></table></div>`;
}

function auditRows() {
  const rows = reportEnvelope?.report?.audit || [];
  if (!rows.length) return `<p class="muted">No audit events for this shift yet.</p>`;
  return `<div class="audit-list">${rows.map((item) => `<div><span class="audit-node"></span><div><strong>${esc(item.action.replaceAll('-', ' '))}</strong><small>${esc(item.detail || item.deviceId || 'Shift event')}</small></div><time>${clockTime(item.atMs)}</time></div>`).join('')}</div>`;
}

function reportPage() {
  const report = reportEnvelope?.report;
  const shifts = reportEnvelope?.shifts || [];
  return `<div class="page report-page"><div class="page-lead"><div><span class="eyebrow">TIMECARD ACTIVITY</span><h1>Activity report</h1><p>See what was received, what was on break, and where the record has gaps.</p></div>
    <div class="lead-actions"><button class="button secondary" data-action="sample-report" ${busy ? 'disabled' : ''}>Load sample report</button><label class="select-label" for="shift-select">SHIFT</label><select id="shift-select" ${shifts.length ? '' : 'disabled'}>${shifts.length ? shifts.map((item) => `<option value="${esc(item.id)}" ${report?.shift.id === item.id ? 'selected' : ''}>${dateTime(item.startedMs)}${item.isSample ? ' · Sample' : item.endedMs ? '' : ' · Open'}</option>`).join('') : '<option>No shifts yet</option>'}</select></div></div>
    ${metricGrid()}
    <section class="card report-timeline-card"><div class="card-heading"><div><span class="eyebrow">COVERAGE</span><h2>${report ? esc(report.shift.workerName) + '’s activity' : 'No activity yet'}</h2></div><span class="state-chip ${report?.shift.endedMs ? '' : 'live'}"><span></span>${report?.shift.isSample ? 'Sample data' : report?.shift.endedMs ? 'Completed' : 'Live shift'}</span></div>${timeline()}
      <div class="report-facts"><div><span>Accepted intervals</span><strong>${report?.eventCount ?? 0}</strong></div><div><span>Desktop pairings</span><strong>${report?.pairingCount ?? 0}</strong></div><div><span>Latest upload delay</span><strong>${report?.lastUploadDelayMs == null ? '—' : span(report.lastUploadDelayMs)}</strong></div></div></section>
    <section class="card report-events"><div class="card-heading"><div><span class="eyebrow">LATEST RECEIVED</span><h2>Desktop intervals</h2></div></div>${eventRows()}</section>
    <div class="report-bottom"><section class="card"><div class="card-heading"><div><span class="eyebrow">TRACE</span><h2>Shift audit</h2></div></div>${auditRows()}</section><section class="card report-explainer"><span class="explainer-icon">${icon('shield', 24)}</span><h2>What this report means</h2><p>Active and idle describe keyboard or mouse input. Break comes from the timecard. Unverified means the server has no accepted desktop interval for that period.</p><p>This view does not change payroll hours.</p></section></div>
  </div>`;
}

function switcher() {
  return `<div class="switcher-backdrop"><div class="switcher-panel" role="dialog" aria-modal="true" aria-labelledby="switcher-title"><div class="switcher-heading"><div><span class="eyebrow">SYNTHETIC PROFILES</span><h2 id="switcher-title">Switch worker</h2></div><button data-action="close-switcher" aria-label="Close worker selection">×</button></div><p>Choose another worker’s web timecard. This does not change desktop attribution; use Change worker in the desktop app before the next pairing.</p><div class="switcher-workers">${state.workers.map((worker) => `<button data-worker="${esc(worker.id)}" class="switcher-worker ${state.worker?.id === worker.id ? 'selected' : ''}"><span class="avatar avatar-${esc(worker.id)}">${esc(worker.initials)}</span><span><strong>${esc(worker.name)}</strong><small>${esc(worker.title)}</small></span>${worker.id === state.worker?.id ? icon('check', 18) : icon('arrow', 18)}</button>`).join('')}</div></div></div>`;
}

function render() {
  if (!state) return;
  root.innerHTML = `<div class="shell">${sidebar()}<div class="workspace">${topbar()}${notice()}${!state.worker ? workerPicker() : tab === 'report' ? reportPage() : tab === 'timecard' ? timecard() : overview()}<footer class="page-footer"><span>MOONBRIDGE ACTIVITY · LOCAL DEMONSTRATION</span><span>All data stays on this computer</span><button data-action="reset">Reset demo data</button></footer></div></div>${showSwitcher && state.worker ? switcher() : ''}`;
}

root.addEventListener('input', (event) => {
  if (event.target.id === 'pair-code') {
    draftCode = event.target.value.replace(/\D/g, '').slice(0, 6);
    event.target.value = draftCode;
    preview = null;
  }
});
root.addEventListener('change', (event) => {
  if (event.target.id === 'shift-select') {
    selectedShiftId = event.target.value;
    void refresh(true);
  }
});
root.addEventListener('submit', (event) => {
  if (event.target.id !== 'pair-form') return;
  event.preventDefault();
  void action(async () => {
    preview = await api('/api/demo/pair-preview', { code: draftCode });
  }, 'Confirm the device below before approving.');
});
root.addEventListener('click', (event) => {
  const workerButton = event.target.closest('[data-worker]');
  if (workerButton) {
    const workerId = workerButton.dataset.worker;
    void action(async () => {
      await api('/api/demo/session', { workerId });
      showSwitcher = false; selectedShiftId = null; draftCode = ''; preview = null;
      tab = 'overview';
    }, `Viewing ${state.workers.find((w) => w.id === workerId)?.name || 'worker'}’s local timecard.`);
    return;
  }
  const tabButton = event.target.closest('[data-tab]');
  if (tabButton) { tab = tabButton.dataset.tab; flash = null; if (tab !== 'report') selectedShiftId = null; void refresh(true); render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const actionName = button.dataset.action;
  if (actionName === 'dismiss') { flash = null; render(); return; }
  if (actionName === 'switch-worker') { showSwitcher = true; render(); return; }
  if (actionName === 'close-switcher') { showSwitcher = false; render(); return; }
  if (actionName === 'clock-in') void action(() => api('/api/demo/clock-in', {}), 'Shift started. Generate a code in the desktop app.');
  if (actionName === 'clock-out') void action(() => api('/api/demo/clock-out', {}), 'Shift closed. Desktop pairing revoked.');
  if (actionName === 'break-start') void action(() => api('/api/demo/break/start', { kind: 'break' }), 'Break started. Desktop collection pauses.');
  if (actionName === 'break-end') void action(() => api('/api/demo/break/end', {}), 'Break ended. Desktop collection can resume.');
  if (actionName === 'approve') void action(async () => {
    await api('/api/desktop/pair/approve', { code: draftCode });
    draftCode = ''; preview = null;
  }, 'Computer approved. The desktop app will connect shortly.');
  if (actionName === 'network') void action(() => api('/api/demo/network', { offline: !state.desktopOffline }), state.desktopOffline ? 'Desktop connection restored.' : 'Desktop connection paused.');
  if (actionName === 'sample-report') void action(async () => {
    const result = await api('/api/demo/sample-report', {});
    selectedShiftId = result.shiftId;
  }, 'Sample report loaded. Its intervals are labeled Sample.');
  if (actionName === 'reset' && confirm('Reset all synthetic shifts, pairings, and activity intervals on this computer?')) {
    void action(async () => { await api('/api/demo/reset', {}); selectedShiftId = null; preview = null; }, 'Local demo data reset.');
  }
});

void refresh(true);
window.setInterval(() => void refresh(), 2500);
