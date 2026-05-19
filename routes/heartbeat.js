'use strict';

const express = require('express');
const { getHeartbeatState, setHeartbeatState } = require('../db/database');
const { sendTelegram } = require('./alerts');

const router = express.Router();

const HEARTBEAT_TIMEOUT_SECONDS = parseInt(process.env.HEARTBEAT_TIMEOUT_SECONDS || '60', 10);
const HEARTBEAT_MONITOR_INTERVAL_MS = parseInt(process.env.HEARTBEAT_MONITOR_INTERVAL_MS || '10000', 10);
function resolveHeartbeatSecret() {
  const secret = String(process.env.HEARTBEAT_SECRET || '').trim();
  if (!secret) {
    throw new Error('HEARTBEAT_SECRET wajib di-set pada .env');
  }
  return secret;
}
const HEARTBEAT_SECRET = resolveHeartbeatSecret();

function nowIso() {
  return new Date().toISOString();
}

function getPublicBaseUrl(req) {
  const configured = String(process.env.HEARTBEAT_PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function computeHeartbeatStatus(lastSeenAt, now = Date.now()) {
  if (!lastSeenAt) return { status: 'UNKNOWN', diffSeconds: null };

  const lastSeenMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) return { status: 'UNKNOWN', diffSeconds: null };

  const diffMs = Math.max(0, now - lastSeenMs);
  const diffSeconds = Math.floor(diffMs / 1000);
  const status = diffMs <= HEARTBEAT_TIMEOUT_SECONDS * 1000 ? 'UP' : 'DOWN';
  return { status, diffSeconds };
}

function buildTelegramMessage(status) {
  if (status === 'DOWN') {
    return '🚨 Internet lokasi DOWN. Heartbeat tidak diterima lebih dari 1 menit.';
  }
  return '✅ Internet lokasi UP lagi. Heartbeat sudah diterima kembali.';
}

async function checkAndNotifyHeartbeatState() {
  const state = getHeartbeatState();
  const { status } = computeHeartbeatStatus(state.lastSeenAt, Date.now());

  if (status === 'UNKNOWN') return;

  const prevStatus = state.lastStatus;
  if (prevStatus === status) return;

  setHeartbeatState({
    lastStatus: status,
    lastTransitionAt: nowIso(),
  });

  if (prevStatus === 'UP' && status === 'DOWN') {
    await sendTelegram(buildTelegramMessage('DOWN'));
    setHeartbeatState({ lastNotificationAt: nowIso() });
  } else if (prevStatus === 'DOWN' && status === 'UP') {
    await sendTelegram(buildTelegramMessage('UP'));
    setHeartbeatState({ lastNotificationAt: nowIso() });
  }
}

function startHeartbeatMonitor() {
  setInterval(() => {
    checkAndNotifyHeartbeatState().catch((err) => {
      console.error('[Heartbeat] monitor error:', err.message);
    });
  }, HEARTBEAT_MONITOR_INTERVAL_MS);
}

function verifySecret(secret) {
  if (!secret) return false;
  return String(secret) === HEARTBEAT_SECRET;
}

router.all('/ping.php', (req, res) => {
  const secret = req.query.secret || req.body.secret || req.get('x-heartbeat-secret');
  if (!verifySecret(secret)) {
    return res.status(403).send('Forbidden');
  }

  const ts = nowIso();
  setHeartbeatState({ lastSeenAt: ts });

  checkAndNotifyHeartbeatState().catch((err) => {
    console.error('[Heartbeat] notify error:', err.message);
  });

  return res.json({ ok: true, status: 'OK', last_seen: ts });
});

router.get('/status', (req, res) => {
  const state = getHeartbeatState();
  const now = Date.now();
  const computed = computeHeartbeatStatus(state.lastSeenAt, now);
  const endpointUrl = `${getPublicBaseUrl(req)}/heartbeat/ping.php?secret=${HEARTBEAT_SECRET}`;

  return res.json({
    ok: true,
    status: computed.status,
    last_seen: state.lastSeenAt,
    seconds_since_last_seen: computed.diffSeconds,
    tolerance_seconds: HEARTBEAT_TIMEOUT_SECONDS,
    endpoint_url: endpointUrl,
    secret: HEARTBEAT_SECRET,
    scheduler_example: `/tool fetch url=\"${endpointUrl}\" keep-result=no`,
  });
});

module.exports = {
  router,
  startHeartbeatMonitor,
  computeHeartbeatStatus,
};
