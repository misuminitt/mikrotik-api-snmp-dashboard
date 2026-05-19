'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.ok) { window.location.href = '/'; return; }
  } catch (_) {
    window.location.href = '/';
    return;
  }

  if (window.gsap) gsap.to('.fade-up', { opacity: 1, y: 0, duration: .5, ease: 'power3.out', stagger: .06 });
  await loadHeartbeatStatus();
  setInterval(loadHeartbeatStatus, 5000);
});

function statusColor(status) {
  if (status === 'UP') return '#22c55e';
  if (status === 'DOWN') return '#ef4444';
  return '#e2e8f0';
}

function formatJakartaTime(iso) {
  if (!iso) return 'Belum ada';
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return 'Belum ada';
  return dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

async function loadHeartbeatStatus() {
  try {
    const data = await fetch('/api/heartbeat/status').then(r => r.json());
    if (!data.ok) throw new Error(data.error || 'Gagal memuat status heartbeat');

    const status = data.status || 'UNKNOWN';

    const statusEl = document.getElementById('hb-status');
    statusEl.textContent = status;
    statusEl.style.color = statusColor(status);

    document.getElementById('hb-last-seen').textContent = formatJakartaTime(data.last_seen);
    document.getElementById('hb-diff').textContent = data.seconds_since_last_seen === null
      ? '-'
      : `${data.seconds_since_last_seen} detik`;
    document.getElementById('hb-timeout').textContent = `${data.tolerance_seconds} detik (1 menit)`;
    document.getElementById('hb-endpoint').textContent = data.endpoint_url || '-';
    document.getElementById('hb-secret').textContent = data.secret || '-';
    document.getElementById('hb-command').textContent = data.scheduler_example || '/tool fetch url="https://domainkamu.com/heartbeat/ping.php?secret=SECRET_ACAK" keep-result=no';
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 5000);
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

window.loadHeartbeatStatus = loadHeartbeatStatus;
window.doLogout = doLogout;
