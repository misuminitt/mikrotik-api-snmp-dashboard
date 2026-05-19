'use strict';
const express = require('express');
const dns = require('dns').promises;
const { getAliases, setAlias } = require('../db/database');

const router = express.Router();
const ptrCache = new Map();
const PTR_TTL_MS = 10 * 60 * 1000;

function now() {
  return Date.now();
}

function validIp(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '');
}

async function resolvePtr(ip) {
  if (!validIp(ip)) return null;
  const cached = ptrCache.get(ip);
  if (cached && (now() - cached.ts) < PTR_TTL_MS) return cached.name;
  try {
    const names = await dns.reverse(ip);
    const name = Array.isArray(names) && names[0] ? String(names[0]) : null;
    ptrCache.set(ip, { ts: now(), name });
    return name;
  } catch (_) {
    ptrCache.set(ip, { ts: now(), name: null });
    return null;
  }
}

router.get('/', (req, res) => {
  res.json({ aliases: getAliases() });
});

router.post('/', (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const alias = String(req.body?.alias || '').trim();
  if (!validIp(ip)) return res.status(400).json({ error: 'Invalid IP' });
  setAlias(ip, alias);
  res.json({ ok: true, ip, alias });
});

router.post('/resolve', async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!validIp(ip)) return res.status(400).json({ error: 'Invalid IP' });
  const hostname = await resolvePtr(ip);
  res.json({ ip, hostname });
});

router.post('/resolve-batch', async (req, res) => {
  const ips = Array.isArray(req.body?.ips) ? req.body.ips : [];
  const cleanIps = ips.map(i => String(i || '').trim()).filter(validIp);
  const result = {};
  await Promise.all(cleanIps.map(async (ip) => {
    result[ip] = await resolvePtr(ip);
  }));
  res.json({ map: result });
});

module.exports = router;
