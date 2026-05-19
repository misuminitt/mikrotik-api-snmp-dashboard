'use strict';

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PORT_NAMES = {
  '80':'HTTP','443':'HTTPS','22':'SSH','21':'FTP','25':'SMTP','53':'DNS',
  '110':'POP3','143':'IMAP','3306':'MySQL','5432':'PgSQL','3389':'RDP',
  '23':'Telnet','8080':'HTTP-Alt','8443':'HTTPS-Alt','1194':'OpenVPN',
  '1723':'PPTP','4500':'IPSec','500':'IKE',
};

/* ─── State ─────────────────────────────────────────────────────────────── */
let pollTimer    = null;
let mediumPollTimer = null;
let connectionsPollTimer = null;
const pollInterval = 3000;
const mediumPollInterval = 12000;
const connectionsPollInterval = 4000;
let rxPeak = 0, txPeak = 0;
let prevRxBytes = {}, prevTxBytes = {}, prevTimestamp = null;
let chartRx, chartTx;
const MAX_POINTS = 40;
const rxData = new Array(MAX_POINTS).fill(0);
const txData = new Array(MAX_POINTS).fill(0);
const LABELS = Array.from({ length: MAX_POINTS }, () => '');
let isOnline = true;
let activeTab = 'dashboard';
let allLeases = [];
let allConns  = [];
let hostnameAliases = {};
let ptrMap = {};
let lastDhcpRendered = [];
let arpCacheMap = {};
let arpCacheAt = 0;
const ARP_CACHE_TTL_MS = 15000;

/* ─── Init ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.ok) { window.location.href = '/'; return; }
    document.getElementById('header-host-label').textContent = me.routerIp;
  } catch (_) {
    window.location.href = '/';
    return;
  }
  await loadAliases();
  initCharts();
  gsap.to('.fade-up', { opacity: 1, y: 0, duration: .5, ease: 'power3.out', stagger: .06, delay: .1 });
  startPolling();
  startStatusMonitor();
});

function isValidIpv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '');
}

function isSubnet50(ip) {
  return String(ip || '').startsWith('192.168.50.');
}

function isSubnet10(ip) {
  return String(ip || '').startsWith('192.168.10.');
}

function isLocalIp(ip) {
  return isSubnet50(ip) || isSubnet10(ip);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveDisplayHostname(ip, leaseHostname) {
  const direct = String(leaseHostname || '').trim();
  if (direct && direct !== '—') return direct;
  const alias = String(hostnameAliases[ip] || '').trim();
  if (alias) return alias;
  const ptr = String(ptrMap[ip] || '').trim();
  if (ptr) return ptr;
  return '-';
}

async function loadAliases() {
  try {
    const data = await fetch('/api/aliases').then(r => r.json());
    hostnameAliases = (data && data.aliases && typeof data.aliases === 'object') ? data.aliases : {};
  } catch (_) {
    hostnameAliases = {};
  }
}

async function resolveMissingPtr(ips) {
  const targets = Array.from(new Set((ips || []).filter(ip => isValidIpv4(ip) && !ptrMap[ip] && !hostnameAliases[ip])));
  if (!targets.length) return;
  try {
    const out = await fetch('/api/aliases/resolve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ips: targets }),
    }).then(r => r.json());
    if (out && out.map && typeof out.map === 'object') {
      ptrMap = { ...ptrMap, ...out.map };
    }
  } catch (_) {}
}

async function editAlias(ip, currentName) {
  const curAlias = hostnameAliases[ip] || (currentName === '-' ? '' : currentName || '');
  const next = window.prompt(`Alias hostname untuk ${ip}`, curAlias);
  if (next === null) return;
  try {
    const res = await fetch('/api/aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, alias: next.trim() }),
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    await loadAliases();
    renderDhcpTable(lastDhcpRendered.length ? lastDhcpRendered : allLeases);
    await fetchIpUsage();
    showToast('Alias hostname tersimpan.', 2500);
  } catch (err) {
    showToast('Gagal simpan alias: ' + err.message, 4000);
  }
}
window.editAlias = editAlias;

/* ─── Tab Switching ──────────────────────────────────────────────────────── */
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('visible'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('section-' + tab).classList.add('visible');
  document.getElementById('tab-' + tab).classList.add('active');
}

/* ─── Utility ────────────────────────────────────────────────────────────── */
function fmt(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtRate(bps) {
  if (bps < 1000) return { val: bps.toFixed(1), unit: 'bps' };
  if (bps < 1e6)  return { val: (bps / 1e3).toFixed(1), unit: 'Kbps' };
  if (bps < 1e9)  return { val: (bps / 1e6).toFixed(2), unit: 'Mbps' };
  return { val: (bps / 1e9).toFixed(2), unit: 'Gbps' };
}

function typeColor(type) {
  const map = { ether:'#3b82f6', wlan:'#22c55e', bridge:'#f59e0b', vlan:'#a855f7', pppoe:'#06b6d4', lte:'#ec4899', loopback:'#64748b' };
  return map[(type || '').toLowerCase()] || '#3b82f6';
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  const current = parseFloat(el.textContent) || 0;
  gsap.to({ val: current }, {
    val: target, duration: .5, ease: 'power2.out',
    onUpdate: function() { el.textContent = Math.round(this.targets()[0].val); }
  });
}

function showToast(msg, duration = 4000) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.display = 'flex';
  gsap.fromTo(t, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .3 });
  setTimeout(() => gsap.to(t, { opacity: 0, y: 8, duration: .3, onComplete: () => t.style.display = 'none' }), duration);
}

/* ─── Charts ─────────────────────────────────────────────────────────────── */
function chartConfig(color, data) {
  return {
    type: 'line',
    data: {
      labels: LABELS.slice(),
      datasets: [{
        data: data.slice(), borderColor: color,
        backgroundColor: color.replace('rgb', 'rgba').replace(')', ',0.08)'),
        borderWidth: 2, pointRadius: 0, tension: 0.45, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false, backgroundColor: '#1e2534',
          titleColor: '#8b9ab0', bodyColor: '#e2e8f0', borderColor: '#2d3748', borderWidth: 1,
          callbacks: { label: ctx => { const f = fmtRate(ctx.raw); return ` ${f.val} ${f.unit}`; } },
        },
      },
      scales: {
        x: { display: false },
        y: {
          display: true, min: 0,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 4,
            callback: v => { const f = fmtRate(v); return f.val + ' ' + f.unit; } },
          border: { display: false },
        },
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
    },
  };
}

function initCharts() {
  chartRx = new Chart(document.getElementById('chart-rx').getContext('2d'), chartConfig('rgb(59,130,246)', rxData));
  chartTx = new Chart(document.getElementById('chart-tx').getContext('2d'), chartConfig('rgb(168,85,247)', txData));
}

function pushChartData(rxBps, txBps) {
  rxData.push(rxBps); rxData.shift();
  txData.push(txBps); txData.shift();
  chartRx.data.datasets[0].data = rxData.slice();
  chartTx.data.datasets[0].data = txData.slice();
  chartRx.options.scales.y.max = Math.max(...rxData) * 1.2 || 1;
  chartTx.options.scales.y.max = Math.max(...txData) * 1.2 || 1;
  chartRx.update('none');
  chartTx.update('none');
}

/* ─── Traffic UI ─────────────────────────────────────────────────────────── */
function updateTrafficUI(rxBps, txBps) {
  const rx = fmtRate(rxBps), tx = fmtRate(txBps);
  document.getElementById('rx-current').textContent = rx.val;
  document.getElementById('rx-unit').textContent    = rx.unit;
  document.getElementById('tx-current').textContent = tx.val;
  document.getElementById('tx-unit').textContent    = tx.unit;
  if (rxBps > rxPeak) {
    rxPeak = rxBps;
    const p = fmtRate(rxPeak);
    document.getElementById('rx-peak').textContent      = p.val;
    document.getElementById('rx-peak-unit').textContent = p.unit;
  }
  if (txBps > txPeak) {
    txPeak = txBps;
    const p = fmtRate(txPeak);
    document.getElementById('tx-peak').textContent      = p.val;
    document.getElementById('tx-peak-unit').textContent = p.unit;
  }
  pushChartData(rxBps, txBps);
}

/* ─── Health UI ─────────────────────────────────────────────────────────── */
function updateHealthUI(data) {
  function normalizeTemp(v) {
    if (!Number.isFinite(v)) return null;
    if (v > 200) return v / 10;
    return v;
  }

  function normalizeVoltage(v) {
    if (!Number.isFinite(v)) return null;
    if (v > 100) return v / 10;
    return v;
  }

  let boardTemp = null, cpuTemp = null, voltage = null;
  if (Array.isArray(data)) {
    data.forEach(item => {
      const n = (item.name || '').toLowerCase();
      const v = parseFloat(item.value);
      if (n.includes('board-temperature') || n === 'temperature') boardTemp = v;
      else if (n.includes('cpu-temperature')) cpuTemp = v;
      else if (n.includes('voltage') || n.includes('psu')) voltage = v;
    });
  } else if (data && typeof data === 'object') {
    boardTemp = parseFloat(data['board-temperature'] || data['temperature'] || NaN);
    cpuTemp   = parseFloat(data['cpu-temperature'] || NaN);
    voltage   = parseFloat(data['voltage'] || NaN);
  }

  boardTemp = normalizeTemp(boardTemp);
  cpuTemp = normalizeTemp(cpuTemp);
  voltage = normalizeVoltage(voltage);

  if (boardTemp !== null && !isNaN(boardTemp)) {
    document.getElementById('board-temp-val').textContent = boardTemp.toFixed(1);
    const pct = Math.min((boardTemp / 90) * 100, 100);
    gsap.to('#board-temp-bar', { width: pct + '%', duration: .6, ease: 'power2.out' });
    document.getElementById('board-temp-bar').style.background =
      boardTemp > 75 ? 'linear-gradient(90deg,#ef4444,#f87171)' :
      boardTemp > 55 ? 'linear-gradient(90deg,#f97316,#fb923c)' :
                       'linear-gradient(90deg,#22c55e,#4ade80)';
  }

  if (cpuTemp !== null && !isNaN(cpuTemp)) {
    document.getElementById('cpu-temp-val').textContent = cpuTemp.toFixed(1);
    const pct = Math.min((cpuTemp / 100) * 100, 100);
    gsap.to('#cpu-temp-bar', { width: pct + '%', duration: .6, ease: 'power2.out' });
    document.getElementById('cpu-temp-bar').style.background =
      cpuTemp > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)' :
      cpuTemp > 60 ? 'linear-gradient(90deg,#f97316,#fb923c)' :
                     'linear-gradient(90deg,#22c55e,#4ade80)';
  }

  if (voltage !== null && !isNaN(voltage)) {
    document.getElementById('voltage-val').textContent = voltage.toFixed(2);
    const pct = Math.min((voltage / 28) * 100, 100);
    gsap.to('#voltage-bar', { width: pct + '%', duration: .6, ease: 'power2.out' });
  }
}

/* ─── Fetch: Resources ───────────────────────────────────────────────────── */
async function fetchResources() {
  const r = await fetch('/api/mikrotik/resources').then(res => res.json());
  if (r.error) throw new Error(r.error);

  const cpu    = parseInt(r['cpu-load'] || 0);
  const total  = parseInt(r['total-memory'] || 1);
  const free   = parseInt(r['free-memory'] || 0);
  const used   = total - free;
  const memPct = Math.round((used / total) * 100);

  animateNumber('cpu-val', cpu);
  gsap.to('#cpu-bar', { width: cpu + '%', duration: .6, ease: 'power2.out' });
  document.getElementById('cpu-bar').style.background =
    cpu > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)' :
    cpu > 50 ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' :
               'linear-gradient(90deg,#3b82f6,#60a5fa)';

  document.getElementById('mem-used').textContent  = Math.round(used / 1048576);
  document.getElementById('mem-total').textContent = Math.round(total / 1048576);
  document.getElementById('mem-pct').textContent   = memPct + '%';
  gsap.to('#mem-bar', { width: memPct + '%', duration: .6, ease: 'power2.out' });

  const u = r['uptime'] || '';
  let d=0,h=0,m=0,s=0;
  const wk=u.match(/(\d+)w/); if(wk) d+=+wk[1]*7;
  const dy=u.match(/(\d+)d/); if(dy) d+=+dy[1];
  const hr=u.match(/(\d+)h/); if(hr) h=+hr[1];
  const mn=u.match(/(\d+)m/); if(mn) m=+mn[1];
  const sc=u.match(/(\d+)s/); if(sc) s=+sc[1];

  document.getElementById('uptime-val').textContent = `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  document.getElementById('up-d').textContent = d;
  document.getElementById('up-h').textContent = h;
  document.getElementById('up-m').textContent = m;
}

/* ─── Fetch: Health ──────────────────────────────────────────────────────── */
async function fetchHealth() {
  try {
    const data = await fetch('/api/mikrotik/health').then(r => r.json());
    if (!data.error) updateHealthUI(data);
  } catch (_) {}
}

/* ─── Fetch: Traffic ─────────────────────────────────────────────────────── */
async function fetchTraffic() {
  const data = await fetch('/api/mikrotik/traffic', { method: 'POST' }).then(r => r.json());
  if (data.error) throw new Error(data.error);
  let totalRx = 0, totalTx = 0;
  if (Array.isArray(data)) {
    data.forEach(e => {
      totalRx += parseInt(e['rx-bits-per-second'] || 0);
      totalTx += parseInt(e['tx-bits-per-second'] || 0);
    });
  }
  updateTrafficUI(totalRx, totalTx);
}

/* ─── Fetch: Interfaces ──────────────────────────────────────────────────── */
async function fetchInterfaces() {
  const { ifaces, stats } = await fetch('/api/mikrotik/interfaces').then(r => r.json());
  const statsMap = {};
  if (Array.isArray(stats)) stats.forEach(s => { statsMap[s.name] = s; });

  const active = (ifaces || []).filter(i => i.running === true || i.running === 'true');
  document.getElementById('iface-count').textContent = `${active.length} interface`;

  const now = Date.now();
  const rows = active.map(iface => {
    const s       = statsMap[iface.name] || iface;
    const rxBytes = parseInt(s['rx-byte'] || 0);
    const txBytes = parseInt(s['tx-byte'] || 0);
    let rxRateHtml = '<span style="color:var(--muted)">—</span>';
    let txRateHtml = '<span style="color:var(--muted)">—</span>';

    if (prevRxBytes[iface.name] !== undefined && prevTimestamp) {
      const dt = (now - prevTimestamp) / 1000;
      if (dt > 0) {
        const rxR = fmtRate(((rxBytes - prevRxBytes[iface.name]) / dt) * 8);
        const txR = fmtRate(((txBytes - prevTxBytes[iface.name]) / dt) * 8);
        rxRateHtml = `<span style="color:#3b82f6;font-family:monospace;">${rxR.val} ${rxR.unit}</span>`;
        txRateHtml = `<span style="color:#a855f7;font-family:monospace;">${txR.val} ${txR.unit}</span>`;
      }
    }
    prevRxBytes[iface.name] = rxBytes;
    prevTxBytes[iface.name] = txBytes;

    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:2px;background:${typeColor(iface.type)};flex-shrink:0;"></div>
        <div><div style="color:#fff;font-weight:500;">${iface.name}</div><div style="color:var(--muted);font-size:.68rem;">${iface.type||'ether'}</div></div>
      </div></td>
      <td style="color:#ccc; font-size:.78rem;">${iface.comment || '—'}</td>
      <td><span class="status-up"><span style="width:5px;height:5px;background:#22c55e;border-radius:50%;display:inline-block;"></span>UP</span></td>
      <td>${rxRateHtml}</td>
      <td>${txRateHtml}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(rxBytes)}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(txBytes)}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${iface['mac-address']||'—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('iface-tbody').innerHTML = rows || `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">Tidak ada interface aktif</td></tr>`;
  prevTimestamp = now;
}

/* ─── Fetch: DHCP Leases ─────────────────────────────────────────────────── */
async function fetchDhcp() {
  const data = await fetch('/api/mikrotik/dhcp-leases').then(r => r.json());
  if (data.error) throw new Error(data.error);
  allLeases = Array.isArray(data) ? data : [];

  const active  = allLeases.filter(l => l.status === 'bound' || l.dynamic === 'true' || l.dynamic === true);
  const waiting = allLeases.filter(l => l.status === 'waiting' || l.status === 'offered');
  const expired = allLeases.filter(l => l.status === 'expired');

  document.getElementById('dhcp-total').textContent   = allLeases.length;
  document.getElementById('dhcp-active').textContent  = active.length;
  document.getElementById('dhcp-waiting').textContent = waiting.length;
  document.getElementById('dhcp-expired').textContent = expired.length;

  // Show count badge on tab
  const badge = document.getElementById('dhcp-badge');
  badge.textContent = allLeases.length;
  badge.style.display = allLeases.length ? 'inline' : 'none';

  await resolveMissingPtr(allLeases.map(l => l['address'] || l['ip-address']).filter(isValidIpv4));
  renderDhcpTable(allLeases);
}

function renderDhcpTable(leases) {
  lastDhcpRendered = leases;
  if (!leases.length) {
    document.getElementById('dhcp-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada data lease.</td></tr>`;
    return;
  }
  document.getElementById('dhcp-tbody').innerHTML = leases.map(l => {
    const ip       = l['address'] || l['ip-address'] || '—';
    const mac      = l['mac-address'] || '—';
    const leaseHostname = l['host-name'] || l['hostname'] || l['active-host-name'] || '';
    const hostname = resolveDisplayHostname(ip, leaseHostname);
    const server   = l['server'] || l['dhcp-server'] || '—';
    const status   = l['status'] || (l.dynamic === 'true' ? 'bound' : 'static');
    const expires  = l['expires-after'] || l['lease-time'] || '—';
    const badge    = status === 'bound'
      ? `<span class="status-up"><span style="width:5px;height:5px;background:#22c55e;border-radius:50%;display:inline-block;"></span>${status}</span>`
      : status === 'waiting' || status === 'offered'
        ? `<span class="status-warn">${status}</span>`
        : `<span style="color:var(--muted);font-size:.75rem;">${status}</span>`;
    return `<tr>
      <td style="font-family:monospace;color:#3b82f6;font-weight:600;">${ip}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.78rem;">${mac}</td>
      <td style="color:#e2e8f0;"><button type="button" onclick="editAlias('${escapeHtml(ip)}','${escapeHtml(hostname)}')" style="background:none;border:none;color:#e2e8f0;cursor:pointer;padding:0;text-align:left;">${escapeHtml(hostname)}</button></td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${server}</td>
      <td>${badge}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${expires}</td>
    </tr>`;
  }).join('');
}

function filterDhcp() {
  const q = document.getElementById('dhcp-search').value.toLowerCase();
  if (!q) { renderDhcpTable(allLeases); return; }
  renderDhcpTable(allLeases.filter(l =>
    (l['address']||'').toLowerCase().includes(q) ||
    (l['mac-address']||'').toLowerCase().includes(q) ||
    resolveDisplayHostname(l['address'] || l['ip-address'] || '', l['host-name']||l['hostname']||l['active-host-name']||'').toLowerCase().includes(q) ||
    (l['server']||'').toLowerCase().includes(q)
  ));
}

/* ─── Fetch: Connections ─────────────────────────────────────────────────── */
async function fetchConnections() {
  const data = await fetch('/api/mikrotik/connections').then(r => r.json());
  if (data.error) throw new Error(data.error);
  allConns = Array.isArray(data) ? data : [];

  const established = allConns.filter(c => (c['tcp-state']||c.state||'').toLowerCase() === 'established');
  const srcIPs  = new Set(allConns.map(c => (c['src-address']||'').split(':')[0]).filter(Boolean));
  const dstPorts = new Set(allConns.map(c => {
    const dst = c['dst-address'] || '';
    return dst.includes(':') ? dst.substring(dst.lastIndexOf(':')+1) : '';
  }).filter(Boolean));

  document.getElementById('conn-total').textContent       = allConns.length;
  document.getElementById('conn-established').textContent = established.length;
  document.getElementById('conn-src-ips').textContent     = srcIPs.size;
  document.getElementById('conn-dst-ports').textContent   = dstPorts.size;
  document.getElementById('conn-count').textContent       = `${allConns.length} koneksi`;

  // Badge on tab
  const badge = document.getElementById('conn-badge');
  badge.textContent = allConns.length;
  badge.style.display = allConns.length ? 'inline' : 'none';

  renderTopPorts(allConns);
  renderTopIPs(allConns);
  renderConnTable(allConns);
}

function renderTopPorts(conns, limit = 8) {
  const portCount = {};
  conns.forEach(c => {
    const dst = c['dst-address'] || '';
    const port = dst.includes(':') ? dst.substring(dst.lastIndexOf(':')+1) : '';
    if (port) portCount[port] = (portCount[port] || 0) + 1;
  });
  const sorted = Object.entries(portCount).sort((a,b)=>b[1]-a[1]).slice(0, limit);
  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ports-list');
  if (!sorted.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.8rem;">Tidak ada data</div>`; return; }
  el.innerHTML = sorted.map(([port, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    const name = PORT_NAMES[port] ? ` <span style="color:var(--muted);font-size:.7rem;">${PORT_NAMES[port]}</span>` : '';
    return `<div class="rank-bar-row">
      <div style="width:80px;flex-shrink:0;font-family:monospace;font-size:.78rem;color:#3b82f6;font-weight:600;">:${port}${name}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:linear-gradient(90deg,#3b82f6,#60a5fa);width:${pct}%;"></div></div>
      <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function renderTopIPs(conns, limit = 8) {
  const ipCount = {};
  conns.forEach(c => {
    const src = (c['src-address']||'').split(':')[0];
    if (src) ipCount[src] = (ipCount[src]||0) + 1;
  });
  const sorted = Object.entries(ipCount).sort((a,b)=>b[1]-a[1]).slice(0, limit);
  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ips-list');
  if (!sorted.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.8rem;">Tidak ada data</div>`; return; }
  el.innerHTML = sorted.map(([ip, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    return `<div class="rank-bar-row">
      <div style="width:120px;flex-shrink:0;font-family:monospace;font-size:.78rem;color:#22c55e;">${ip}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:linear-gradient(90deg,#22c55e,#4ade80);width:${pct}%;"></div></div>
      <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function renderConnTable(conns) {
  if (!conns.length) {
    document.getElementById('conn-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada koneksi aktif.</td></tr>`;
    return;
  }
  document.getElementById('conn-tbody').innerHTML = conns.map(c => {
    const proto   = (c.protocol || '—').toUpperCase();
    const srcFull = c['src-address'] || '—';
    const dstFull = c['dst-address'] || '—';

    const srcSplit = srcFull.lastIndexOf(':');
    const srcIp   = srcSplit > 0 ? srcFull.substring(0, srcSplit) : srcFull;
    const srcPort = srcSplit > 0 ? srcFull.substring(srcSplit+1) : '—';

    const dstSplit = dstFull.lastIndexOf(':');
    const dstIp   = dstSplit > 0 ? dstFull.substring(0, dstSplit) : dstFull;
    const dstPort = dstSplit > 0 ? dstFull.substring(dstSplit+1) : '—';

    const portLabel = PORT_NAMES[dstPort] ? ` <span style="color:var(--muted);font-size:.68rem;">${PORT_NAMES[dstPort]}</span>` : '';
    const state     = c['tcp-state'] || c.state || '—';
    const stateBadge = state.toLowerCase() === 'established'
      ? `<span class="status-up" style="font-size:.68rem;">${state}</span>`
      : `<span class="status-warn" style="font-size:.68rem;">${state}</span>`;

    const bytes = (() => {
      const b = (parseInt(c['orig-bytes']||0) + parseInt(c['repl-bytes']||0));
      return fmt(b);
    })();

    return `<tr>
      <td><span style="font-family:monospace;font-size:.72rem;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:4px;padding:1px 6px;color:#60a5fa;">${proto}</span></td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${srcIp}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${srcPort}</td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${dstIp}</td>
      <td style="font-family:monospace;font-size:.78rem;color:#a855f7;">${dstPort}${portLabel}</td>
      <td>${stateBadge}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${bytes}</td>
    </tr>`;
  }).join('');
}

function filterConnections() {
  const q = document.getElementById('conn-search').value.toLowerCase();
  const filtered = q ? allConns.filter(c => JSON.stringify(c).toLowerCase().includes(q)) : allConns;
  renderConnTable(filtered);
  document.getElementById('conn-count').textContent = `${filtered.length} koneksi`;
}

/* ─── Poll Loop ──────────────────────────────────────────────────────────── */
async function fetchAll() {
  try {
    await Promise.all([
      fetchTraffic(),
      fetchResources(),
      fetchInterfaces(),
      fetchHealth(),
      fetchHistory(),
      fetchHeartbeatStatus(),
    ]);
    await fetchIpUsage();
    document.getElementById('last-update').textContent =
      new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

async function fetchHeartbeatStatus() {
  try {
    const data = await fetch('/api/heartbeat/status').then(r => r.json());
    if (!data.ok) return;

    const status = data.status || 'UNKNOWN';
    const statusEl = document.getElementById('hb-status');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.style.color = status === 'UP' ? '#22c55e' : status === 'DOWN' ? '#ef4444' : '#e2e8f0';
    }

    const lastSeenEl = document.getElementById('hb-last-seen');
    if (lastSeenEl) {
      if (!data.last_seen) {
        lastSeenEl.textContent = 'Belum ada';
      } else {
        const dt = new Date(data.last_seen);
        lastSeenEl.textContent = Number.isFinite(dt.getTime())
          ? dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          : 'Belum ada';
      }
    }

    const diffEl = document.getElementById('hb-diff');
    if (diffEl) {
      diffEl.textContent = data.seconds_since_last_seen == null
        ? '-'
        : `${data.seconds_since_last_seen} detik`;
    }

    const timeoutEl = document.getElementById('hb-timeout');
    if (timeoutEl) timeoutEl.textContent = `${data.tolerance_seconds} detik (1 menit)`;

    const endpointEl = document.getElementById('hb-endpoint');
    if (endpointEl) endpointEl.textContent = data.endpoint_url || '-';

    const secretEl = document.getElementById('hb-secret');
    if (secretEl) secretEl.textContent = data.secret || '-';

    const commandEl = document.getElementById('hb-command');
    if (commandEl) {
      commandEl.textContent = data.scheduler_example || '/tool fetch url="https://domainkamu.com/heartbeat/ping.php?secret=SECRET_ACAK" keep-result=no';
    }
  } catch (_) {}
}

function startPolling() {
  fetchAll();
  pollTimer = setInterval(fetchAll, pollInterval);

  fetchMediumData();
  mediumPollTimer = setInterval(fetchMediumData, mediumPollInterval);

  fetchConnectionsSafe();
  connectionsPollTimer = setInterval(fetchConnectionsSafe, connectionsPollInterval);
}

async function fetchMediumData() {
  try {
    await Promise.all([
      fetchDhcp(),
      fetchDnsCache(),
    ]);
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

async function fetchConnectionsSafe() {
  try {
    await fetchConnections();
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

/* ─── Status Monitor ─────────────────────────────────────────────────────── */
async function startStatusMonitor() {
  setInterval(async () => {
    try {
      const { online } = await fetch('/api/alerts/status').then(r => r.json());
      const banner = document.getElementById('offline-banner');
      if (!online && isOnline) {
        isOnline = false;
        banner.style.display = 'block';
        showToast('Router offline! Tim NOC diberitahu via Telegram.', 6000);
      } else if (online && !isOnline) {
        isOnline = true;
        banner.style.display = 'none';
        showToast('Router kembali online!', 4000);
      }
    } catch (_) {}
  }, 15000);
}

/* ─── Actions ────────────────────────────────────────────────────────────── */
async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

async function testTelegram() {
  try {
    await fetch('/api/alerts/test', { method: 'POST' });
    showToast('Notifikasi test berhasil dikirim ke Telegram!', 4000);
  } catch (err) {
    showToast('Gagal kirim test Telegram: ' + err.message);
  }
}

/* ─── Settings Modal ─────────────────────────────────────────────────────── */
function openSettingsModal() {
  document.getElementById('settings-modal').style.display = 'flex';
  switchSettingsTab('mikrotik');
  loadSettings();
}

function closeSettingsModal() {
  document.getElementById('settings-modal').style.display = 'none';
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.remove('active'));
  const btn = document.getElementById(`st-${tab}`);
  const pane = document.getElementById(`settings-${tab}`);
  if (btn) btn.classList.add('active');
  if (pane) pane.classList.add('active');
}

async function loadSettings() {
  try {
    const data = await fetch('/api/settings').then(r => r.json());
    const keys = [
      'MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASS', 'SESSION_SECRET',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PORT', 'HEALTH_CHECK_INTERVAL',
    ];
    keys.forEach((k) => {
      const el = document.getElementById(`s_${k}`);
      if (!el) return;
      el.value = data[k] ?? '';
    });
  } catch (err) {
    showToast('Gagal load settings: ' + err.message, 4500);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('settings-save-btn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  try {
    const keys = [
      'MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASS', 'SESSION_SECRET',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PORT', 'HEALTH_CHECK_INTERVAL',
    ];
    const payload = {};
    keys.forEach((k) => {
      const el = document.getElementById(`s_${k}`);
      if (!el) return;
      payload[k] = el.value;
    });

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok || out.error) throw new Error(out.error || 'Gagal simpan settings');

    closeSettingsModal();
    showToast(out.message || 'Settings tersimpan', 4500);
    if (out.requiresRestart) {
      showToast('Server sedang restart. Tunggu beberapa detik lalu refresh.', 7000);
    }
  } catch (err) {
    showToast('Simpan settings gagal: ' + err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* ─── History Chart ─────────────────────────────────────────────────────────── */
let chartHistory = null;

function initHistoryChart() {
  const ctx = document.getElementById('chart-history');
  if (!ctx || chartHistory) return;
  chartHistory = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'RX', data: [], borderColor: 'rgb(59,130,246)',  backgroundColor: 'rgba(59,130,246,.08)',  borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true },
        { label: 'TX', data: [], borderColor: 'rgb(168,85,247)', backgroundColor: 'rgba(168,85,247,.08)', borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      plugins: {
        legend: { display: true, labels: { color: '#8b9ab0', font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          mode: 'index', intersect: false, backgroundColor: '#1e2534',
          titleColor: '#8b9ab0', bodyColor: '#e2e8f0', borderColor: '#2d3748', borderWidth: 1,
          callbacks: { label: ctx => { const f = fmtRate(ctx.raw); return ` ${ctx.dataset.label}: ${f.val} ${f.unit}`; } },
        },
      },
      scales: {
        x: { display: true, ticks: { color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,.03)' }, border: { display: false } },
        y: { display: true, min: 0, grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 5,
            callback: v => { const f = fmtRate(v); return f.val + ' ' + f.unit; } },
          border: { display: false },
        },
      },
    },
  });
}

/* ─── Fetch: IP Usage (Bandwidth & Port Real-time) ───────────────────────── */
let prevIpUsageBytes = {};
let prevIpTimestamp = null;
const INTERNET_IFACE = 'ether1';

function getInternetIp() {
  const hostLabel = (document.getElementById('header-host-label')?.textContent || '').trim();
  const host = hostLabel.split(':')[0];
  return host || '192.168.20.1';
}

async function fetchIpUsage() {
  try {
    const INTERNET_IP = getInternetIp();
    const arpMap = await getArpMapCached();

    const hostMap = {};
    allLeases.forEach(l => {
      const ip = l.address || l['ip-address'];
      if (ip) {
        hostMap[ip] = l['host-name'] || l.hostname || l['active-host-name'] || '';
      }
    });
    hostMap[INTERNET_IP] = 'Internet';

    const ipStats = {};
    
    ipStats[INTERNET_IP] = { rx:0, tx:0, interface: INTERNET_IFACE, hostname: 'Internet' };
    
    allConns.forEach(c => {
      const srcFull = c['src-address'] || '';
      const srcSplit = srcFull.lastIndexOf(':');
      const ip = srcSplit > 0 ? srcFull.substring(0, srcSplit) : srcFull;
      if (!ip || ip.includes(':')) return;
      if (!isLocalIp(ip)) return;
      
      const rx = parseInt(c['repl-bytes'] || 0); // RX is reply bytes
      const tx = parseInt(c['orig-bytes'] || 0); // TX is original bytes

      if (!ipStats[ip]) {
          ipStats[ip] = { 
              rx:0, tx:0, 
              interface: arpMap[ip] || (ip === INTERNET_IP ? INTERNET_IFACE : '—'), 
              hostname: resolveDisplayHostname(ip, hostMap[ip] || '')
          };
      }
      ipStats[ip].rx += rx;
      ipStats[ip].tx += tx;
    });

    const tbody = document.getElementById('queue-tbody');
    const now = Date.now();
    const dt = prevIpTimestamp ? ((now - prevIpTimestamp) / 1000) : 0;

    const rows = Object.keys(ipStats).map((ip) => {
      const st = ipStats[ip];
      let rxRate = 0;
      let txRate = 0;

      if (prevIpUsageBytes[ip] !== undefined && dt > 0) {
        const r1 = ((st.rx - prevIpUsageBytes[ip].rx) / dt) * 8;
        const r2 = ((st.tx - prevIpUsageBytes[ip].tx) / dt) * 8;
        if (r1 >= 0 && r2 >= 0) {
          rxRate = r1;
          txRate = r2;
        }
      }

      const hasMovement = (rxRate > 0 || txRate > 0);
      const isInternet = ip === INTERNET_IP;
      const visible = isInternet || hasMovement;
      return { ip, st, rxRate, txRate, visible };
    }).filter(r => r.visible);

    await resolveMissingPtr(rows.map(r => r.ip));
    rows.forEach(r => { r.st.hostname = resolveDisplayHostname(r.ip, r.st.hostname); });
    const sortedRows = rows.sort((a, b) => ((b.rxRate + b.txRate) - (a.rxRate + a.txRate)) || ((b.st.rx + b.st.tx) - (a.st.rx + a.st.tx)));
    const internetRows = sortedRows.filter(r => r.ip === INTERNET_IP);
    const group50 = sortedRows.filter(r => r.ip !== INTERNET_IP && isSubnet50(r.ip));
    const group10 = sortedRows.filter(r => isSubnet10(r.ip));
    const finalRows = [...internetRows, ...group50, ...group10];
    
    document.getElementById('queue-count').textContent = `${finalRows.length} IP`;

    if (!finalRows.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada data koneksi.</td></tr>`;
      return;
    }

    const rowHtmlByIp = {};
    const buildRow = (row) => {
      const ip = row.ip;
      const st = row.st;
      let rxRHtml = '<span style="color:var(--muted)">—</span>';
      let txRHtml = '<span style="color:var(--muted)">—</span>';

      if (prevIpUsageBytes[ip] !== undefined && prevIpTimestamp) {
        const dt = (now - prevIpTimestamp) / 1000;
        if (dt > 0) {
          let rxRate = ((st.rx - prevIpUsageBytes[ip].rx) / dt) * 8;
          let txRate = ((st.tx - prevIpUsageBytes[ip].tx) / dt) * 8;
          if (rxRate >= 0 && txRate >= 0) {
              const rxR = fmtRate(rxRate);
              const txR = fmtRate(txRate);
              rxRHtml = `<span style="color:#22c55e;font-family:monospace;">${rxR.val} ${rxR.unit}</span>`;
              txRHtml = `<span style="color:#a855f7;font-family:monospace;">${txR.val} ${txR.unit}</span>`;
          }
        }
      }

      return `<tr>
        <td style="font-family:monospace;color:#3b82f6;font-weight:600;">${ip}</td>
        <td style="color:#e2e8f0;font-size:.78rem;"><button type="button" onclick="editAlias('${escapeHtml(ip)}','${escapeHtml(st.hostname)}')" style="background:none;border:none;color:#e2e8f0;cursor:pointer;padding:0;text-align:left;">${escapeHtml(st.hostname)}</button></td>
        <td style="color:#e2e8f0;font-size:.78rem;">${st.interface}</td>
        <td>${rxRHtml}</td>
        <td>${txRHtml}</td>
        <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(st.rx)}</td>
        <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(st.tx)}</td>
      </tr>`;
    };
    finalRows.forEach(r => { rowHtmlByIp[r.ip] = buildRow(r); });

    const assembled = [];
    internetRows.forEach(r => assembled.push(rowHtmlByIp[r.ip]));
    if (group50.length) {
      assembled.push('<tr><td colspan="7" style="font-size:.72rem;color:#93c5fd;background:rgba(59,130,246,.08);font-weight:700;">R15 / Pribadi (192.168.50.0/24)</td></tr>');
      group50.forEach(r => assembled.push(rowHtmlByIp[r.ip]));
    }
    if (group10.length) {
      assembled.push('<tr><td colspan="7" style="font-size:.72rem;color:#86efac;background:rgba(34,197,94,.08);font-weight:700;">Samara (192.168.10.0/24)</td></tr>');
      group10.forEach(r => assembled.push(rowHtmlByIp[r.ip]));
    }
    tbody.innerHTML = assembled.join('');

    prevIpUsageBytes = Object.fromEntries(Object.entries(ipStats).map(([k,v]) => [k, {rx:v.rx, tx:v.tx}]));
    prevIpTimestamp = now;

  } catch (err) {
    document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:28px;">Gagal: ${err.message}</td></tr>`;
  }
}

async function getArpMapCached() {
  const now = Date.now();
  if (now - arpCacheAt <= ARP_CACHE_TTL_MS && Object.keys(arpCacheMap).length) {
    return arpCacheMap;
  }

  const arpData = await fetch('/api/mikrotik/arp').then(r => r.json()).catch(() => []);
  const arpList = Array.isArray(arpData) ? arpData : [];
  const nextMap = {};
  arpList.forEach((a) => {
    if (a && a.address) nextMap[a.address] = a.interface;
  });
  arpCacheMap = nextMap;
  arpCacheAt = now;
  return arpCacheMap;
}

/* ─── Fetch: Firewall Stats + System Log ────────────────────────────────────── */
const BRUTE_KEYWORDS = ['login failure', 'login failed', 'brute', 'port scan', 'syn flood', 'blocked', 'dropped', 'invalid'];
let allLogs = [];

async function fetchFirewallAndLogs() {
  // Firewall
  try {
    const fwData = await fetch('/api/mikrotik/firewall-stats').then(r => r.json());
    if (!fwData.error) renderFirewallTable(fwData);
  } catch (_) {}

  // Logs
  try {
    const logs = await fetch('/api/mikrotik/logs').then(r => r.json());
    if (!Array.isArray(logs)) return;
    allLogs = logs;

    // Brute force / scan detection
    const bruteEntries = logs.filter(l => BRUTE_KEYWORDS.some(k => (l.message||l.topics||'').toLowerCase().includes(k)));
    const brutePanel   = document.getElementById('brute-panel');
    if (bruteEntries.length) {
      brutePanel.style.display = 'block';
      document.getElementById('brute-count').textContent = `${bruteEntries.length} kejadian`;
      document.getElementById('brute-list').innerHTML = bruteEntries.slice(0, 10).map(l =>
        `<div>[${l.time||''}] ${l.topics||''} — ${l.message||''}</div>`).join('');
      const fwBadge = document.getElementById('fw-badge');
      fwBadge.textContent = bruteEntries.length;
      fwBadge.style.display = 'inline';
    } else {
      brutePanel.style.display = 'none';
      document.getElementById('fw-badge').style.display = 'none';
    }

    // Severity summary
    const sev = { critical:0, error:0, warning:0, info:0, debug:0 };
    logs.forEach(l => {
      const t = (l.topics||'').toLowerCase();
      if (t.includes('critical')) sev.critical++;
      else if (t.includes('error')) sev.error++;
      else if (t.includes('warning')||t.includes('warn')) sev.warning++;
      else if (t.includes('debug')) sev.debug++;
      else sev.info++;
    });
    const maxSev = Math.max(...Object.values(sev)) || 1;
    const sevColors = { critical:'#ef4444', error:'#f97316', warning:'#f59e0b', info:'#3b82f6', debug:'#8b9ab0' };
    document.getElementById('log-summary').innerHTML = Object.entries(sev).filter(([,v])=>v>0).map(([k,v]) =>
      `<div class="rank-bar-row">
        <div style="width:64px;flex-shrink:0;font-size:.75rem;color:${sevColors[k]};font-weight:600;text-transform:capitalize;">${k}</div>
        <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:${sevColors[k]};width:${(v/maxSev*100).toFixed(0)}%;"></div></div>
        <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${v}</div>
      </div>`).join('');

    renderLogViewer(logs);
  } catch (_) {}
}

function renderFirewallTable(fwData) {
  const rules = [...(fwData.filter||[]),...(fwData.nat||[]),...(fwData.mangle||[])]
    .filter(r => r.action==='drop'||r.action==='reject'||r.action==='tarpit')
    .sort((a,b) => parseInt(b.packets||0)-parseInt(a.packets||0))
    .slice(0,20);
  if (!rules.length) {
    document.getElementById('fw-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">Tidak ada drop rule aktif.</td></tr>`;
    return;
  }
  const actionColor = { drop:'#ef4444', reject:'#f97316', tarpit:'#8b5cf6' };
  document.getElementById('fw-tbody').innerHTML = rules.map(r => {
    const pkt = parseInt(r.packets||0);
    return `<tr>
      <td style="font-family:monospace;font-size:.75rem;color:#3b82f6;">${r.chain||'—'}</td>
      <td><span style="background:${(actionColor[r.action]||'#64748b')}22;border:1px solid ${(actionColor[r.action]||'#64748b')}44;border-radius:4px;padding:1px 6px;font-size:.68rem;color:${actionColor[r.action]||'#94a3b8'};font-family:monospace;">${r.action}</span></td>
      <td style="font-family:monospace;font-size:.75rem;color:#94a3b8;">${r['src-address']||r['src-address-list']||'any'}</td>
      <td style="font-family:monospace;font-size:.75rem;color:#a855f7;">${r['dst-port']||'—'}</td>
      <td style="font-family:monospace;font-size:.75rem;color:${pkt>1000?'#f87171':'#e2e8f0'};font-weight:${pkt>1000?700:400};">${pkt.toLocaleString()}</td>
      <td style="font-family:monospace;font-size:.75rem;color:#94a3b8;">${fmt(parseInt(r.bytes||0))}</td>
    </tr>`;
  }).join('');
}

const LOG_COLORS = {
  critical: { bg:'rgba(239,68,68,.15)',   border:'rgba(239,68,68,.3)',   text:'#f87171' },
  error:    { bg:'rgba(249,115,22,.12)',  border:'rgba(249,115,22,.25)', text:'#fb923c' },
  warning:  { bg:'rgba(245,158,11,.1)',   border:'rgba(245,158,11,.2)',  text:'#fbbf24' },
  info:     { bg:'rgba(59,130,246,.08)',  border:'rgba(59,130,246,.15)', text:'#60a5fa' },
  debug:    { bg:'rgba(100,116,139,.08)', border:'rgba(100,116,139,.15)',text:'#94a3b8' },
};

function logSeverity(l) {
  const t = (l.topics||'').toLowerCase();
  if (t.includes('critical')) return 'critical';
  if (t.includes('error'))    return 'error';
  if (t.includes('warning')||t.includes('warn')) return 'warning';
  if (t.includes('debug'))    return 'debug';
  return 'info';
}

function renderLogViewer(logs) {
  const q     = (document.getElementById('log-search')?.value||'').toLowerCase();
  const topic = document.getElementById('log-filter-topic')?.value||'';
  const filt  = logs.filter(l => {
    if (topic && !(l.topics||'').toLowerCase().includes(topic)) return false;
    if (q && !JSON.stringify(l).toLowerCase().includes(q)) return false;
    return true;
  });
  document.getElementById('log-viewer').innerHTML = filt.slice(0,100).map(l => {
    const sev = logSeverity(l);
    const c   = LOG_COLORS[sev]||LOG_COLORS.info;
    return `<div style="padding:4px 8px;border-radius:5px;background:${c.bg};border-left:2px solid ${c.border};display:flex;gap:10px;">
      <span style="color:${c.text};min-width:60px;flex-shrink:0;">[${(l.time||'').substring(0,8)}]</span>
      <span style="color:#8b9ab0;min-width:70px;flex-shrink:0;font-size:.7rem;">${(l.topics||'').substring(0,20)}</span>
      <span style="color:#e2e8f0;">${l.message||''}</span>
    </div>`;
  }).join('')||`<div style="color:var(--muted);padding:16px;text-align:center;">Tidak ada log yang cocok.</div>`;
}

function filterLog() { renderLogViewer(allLogs); }

/* ─── Fetch: DNS Cache ───────────────────────────────────────────────────────── */
let allDns = [];

async function fetchDnsCache() {
  try {
    const data = await fetch('/api/mikrotik/dns-cache').then(r => r.json());
    if (data.error) return;
    allDns = Array.isArray(data) ? data : [];
    document.getElementById('dns-count').textContent = `${allDns.length} entry`;
    renderDnsTable(allDns);
  } catch (_) {}
}

function renderDnsTable(entries) {
  if (!entries.length) {
    document.getElementById('dns-tbody').innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada cache DNS.</td></tr>`;
    return;
  }
  document.getElementById('dns-tbody').innerHTML = entries.map(e => {
    const name = e.name||'—';
    const type = e.type||e['dns-type']||'A';
    const addr = e.address||e.data||'—';
    const ttl  = e.ttl||e['live-time']||'—';
    const tc   = type==='AAAA'?'#a855f7':type==='CNAME'?'#f59e0b':type==='MX'?'#22c55e':'#3b82f6';
    return `<tr>
      <td style="color:#e2e8f0;font-family:monospace;font-size:.8rem;">${name}</td>
      <td><span style="background:${tc}22;border:1px solid ${tc}44;border-radius:4px;padding:1px 6px;font-size:.7rem;color:${tc};font-family:monospace;">${type}</span></td>
      <td style="font-family:monospace;color:#3b82f6;font-size:.78rem;">${addr}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${ttl}</td>
    </tr>`;
  }).join('');
}

function filterDns() {
  const q = document.getElementById('dns-search').value.toLowerCase();
  renderDnsTable(q ? allDns.filter(e => JSON.stringify(e).toLowerCase().includes(q)) : allDns);
}

/* ─── Fetch: History (chart + alerts + uptime) ───────────────────────────────── */
async function fetchHistory() {
  try {
    initHistoryChart();
    const [traffic, uptimeEvts, thresholdEvts] = await Promise.all([
      fetch('/api/history/traffic').then(r => r.json()).catch(() => []),
      fetch('/api/history/uptime').then(r => r.json()).catch(() => []),
      fetch('/api/history/threshold-alerts').then(r => r.json()).catch(() => []),
    ]);

    // Traffic history chart
    if (chartHistory && Array.isArray(traffic) && traffic.length) {
      chartHistory.data.labels = traffic.map(p => {
        const d = new Date(p.ts);
        return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
      });
      chartHistory.data.datasets[0].data = traffic.map(p => p.rxBps);
      chartHistory.data.datasets[1].data = traffic.map(p => p.txBps);
      chartHistory.update('none');
      document.getElementById('history-points').textContent = `${traffic.length} titik data`;
    }

    // Threshold alert list
    const alertEl = document.getElementById('alert-list');
    const alertBadge = document.getElementById('alert-badge');
    if (!thresholdEvts.length) {
      alertEl.innerHTML = `<div style="color:var(--muted);font-size:.82rem;text-align:center;padding:20px;display:flex;align-items:center;justify-content:center;gap:8px;"><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Tidak ada threshold alert tercatat.</div>`;
      alertBadge.style.display = 'none';
    } else {
      alertBadge.textContent = thresholdEvts.length;
      alertBadge.style.display = 'inline';
      alertEl.innerHTML = thresholdEvts.map(a => {
        const ts    = new Date(a.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const color = a.type==='cpu'?'#3b82f6':a.type==='cpu-temp'?'#ef4444':'#f97316';
        return `<div style="background:${color}11;border:1px solid ${color}33;border-radius:8px;padding:8px 12px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
            <span style="font-weight:600;color:#fff;font-size:.8rem;">${a.label}</span>
            <span style="font-size:.7rem;color:var(--muted);">${ts}</span>
          </div>
          <div style="font-size:.75rem;color:#ccc;">Nilai: <strong>${(a.value||0).toFixed(1)}${a.unit}</strong> &gt; threshold ${a.threshold}${a.unit}</div>
        </div>`;
      }).join('');
    }

    // Uptime / reboot history
    const uptimeEl = document.getElementById('uptime-list');
    if (!uptimeEvts.length) {
      uptimeEl.innerHTML = `<div style="color:var(--muted);font-size:.82rem;text-align:center;padding:20px;">Belum ada event uptime tercatat.</div>`;
    } else {
      uptimeEl.innerHTML = uptimeEvts.map(e => {
        const ts    = new Date(e.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const iconSvg = e.event==='reboot'
          ? `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`
          : `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3l14 9-14 9V3z"/></svg>`;
        const color = e.event==='reboot'?'#f97316':'#22c55e';
        return `<div style="background:${color}11;border:1px solid ${color}33;border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:.82rem;color:#fff;display:flex;align-items:center;gap:6px;">${iconSvg} ${e.label}</span>
          <div style="text-align:right;">
            <div style="font-size:.7rem;color:var(--muted);">${ts}</div>
            <div style="font-family:monospace;font-size:.72rem;color:#ccc;">${e.uptimeStr}</div>
          </div>
        </div>`;
      }).join('');
    }
  } catch (_) {}
}
