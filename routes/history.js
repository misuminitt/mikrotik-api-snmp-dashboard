'use strict';



const MAX_TRAFFIC_POINTS = 1440; // 24h at 1 poll/minute
const MAX_EVENTS         = 200;
const trafficHistory  = [];   // { ts, rxBps, txBps }
const uptimeEvents    = [];   // { ts, event:'start'|'reboot', uptimeStr }
const thresholdAlerts = [];   // { ts, type, value, threshold, routerIp }
let prevUptimeSeconds = null;
const alertCooldown = {}; // { 'cpu'|'cpu-temp'|'board-temp': lastSentMs }
const COOLDOWN_MS   = 5 * 60 * 1000; // 5 minutes
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function uptimeToSeconds(upStr) {
  if (!upStr) return 0;
  let s = 0;
  const wk = upStr.match(/(\d+)w/); if (wk) s += +wk[1] * 7 * 86400;
  const dy = upStr.match(/(\d+)d/); if (dy) s += +dy[1] * 86400;
  const hr = upStr.match(/(\d+)h/); if (hr) s += +hr[1] * 3600;
  const mn = upStr.match(/(\d+)m/); if (mn) s += +mn[1] * 60;
  const sc = upStr.match(/(\d+)s/); if (sc) s += +sc[1];
  return s;
}
function recordTraffic(rxBps, txBps) {
  pushCapped(trafficHistory, { ts: Date.now(), rxBps, txBps }, MAX_TRAFFIC_POINTS);
}
function recordUptime(uptimeStr) {
  const currentSec = uptimeToSeconds(uptimeStr);
  if (prevUptimeSeconds === null) {
    pushCapped(uptimeEvents, {
      ts: Date.now(),
      event: 'start',
      uptimeStr,
      label: 'Dashboard mulai monitoring'
    }, MAX_EVENTS);
  } else if (currentSec < prevUptimeSeconds - 30) {
    pushCapped(uptimeEvents, {
      ts: Date.now(),
      event: 'reboot',
      uptimeStr,
      label: 'Router reboot terdeteksi'
    }, MAX_EVENTS);
  }
  prevUptimeSeconds = currentSec;
}
async function checkThresholds({ cpuLoad, cpuTemp, boardTemp, routerIp, sendTelegram }) {
  const now = Date.now();

  const checks = [
    {
      key:       'cpu',
      value:     cpuLoad,
      threshold: 80,
      unit:      '%',
      label:     '🔥 CPU Load',
      emoji:     '⚡',
    },
    {
      key:       'cpu-temp',
      value:     cpuTemp,
      threshold: 75,
      unit:      '°C',
      label:     '🌡️ CPU Temperature',
      emoji:     '🔴',
    },
    {
      key:       'board-temp',
      value:     boardTemp,
      threshold: 60,
      unit:      '°C',
      label:     '🌡️ Board Temperature',
      emoji:     '🟠',
    },
  ];

  for (const check of checks) {
    if (check.value === null || isNaN(check.value)) continue;
    if (check.value <= check.threshold) continue;
    const lastSent = alertCooldown[check.key] || 0;
    if (now - lastSent < COOLDOWN_MS) continue;
    pushCapped(thresholdAlerts, {
      ts:        now,
      type:      check.key,
      label:     check.label,
      value:     check.value,
      threshold: check.threshold,
      unit:      check.unit,
      routerIp,
    }, MAX_EVENTS);

    alertCooldown[check.key] = now;
    const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const msg =
      `${check.emoji} <b>Threshold Alert — ${check.label}</b>\n\n` +
      `📡 <b>Router:</b> <code>${routerIp}</code>\n` +
      `📊 <b>Nilai saat ini:</b> ${check.value.toFixed(1)}${check.unit}\n` +
      `⚠️ <b>Batas:</b> ${check.threshold}${check.unit}\n` +
      `🕐 <b>Waktu:</b> ${ts}\n` +
      `🔧 <b>Sistem:</b> 2Arah Tech — MikroTik Dashboard`;

    console.log(`[Threshold] ${check.label} = ${check.value}${check.unit} > ${check.threshold}${check.unit} — Telegram dikirim`);
    await sendTelegram(msg).catch(e => console.error('[Threshold] Telegram error:', e.message));
  }
}
const express = require('express');
const router  = express.Router();

router.get('/traffic', (req, res) => {
  return res.json(trafficHistory.slice(-288));
});

router.get('/uptime', (req, res) => {
  return res.json([...uptimeEvents].reverse()); // newest first
});

router.get('/threshold-alerts', (req, res) => {
  return res.json([...thresholdAlerts].reverse()); // newest first
});

module.exports = { router, recordTraffic, recordUptime, checkThresholds };
