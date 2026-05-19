const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ENV_PATH = path.join(__dirname, '../.env');

function parseEnv() {
  const envVars = {};
  if (!fs.existsSync(ENV_PATH)) return envVars;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  lines.forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx < 0) return;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
  });
  return envVars;
}

router.get('/', (req, res) => {
  const envVars = parseEnv();
  const safeEnv = { ...envVars };
  const maskFields = ['DASHBOARD_PASS', 'MK_PASS', 'TELEGRAM_BOT_TOKEN', 'TECHNITIUM_TOKEN'];
  maskFields.forEach(field => {
    if (safeEnv[field]) {
      safeEnv[field] = '********';
    }
  });
  res.json(safeEnv);
});

router.post('/', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const currentEnv = parseEnv();
  let requiresRestart = false;

  if (
    (payload.PORT && payload.PORT !== currentEnv.PORT) ||
    (payload.TELEGRAM_BOT_TOKEN && payload.TELEGRAM_BOT_TOKEN !== '********' && payload.TELEGRAM_BOT_TOKEN !== currentEnv.TELEGRAM_BOT_TOKEN) ||
    (payload.TELEGRAM_CHAT_ID && payload.TELEGRAM_CHAT_ID !== currentEnv.TELEGRAM_CHAT_ID) ||
    (payload.PING_TARGET && payload.PING_TARGET !== currentEnv.PING_TARGET)
  ) {
    requiresRestart = true;
  }

  const prefixesToDelete = Array.isArray(payload._DELETE_PREFIXES) ? payload._DELETE_PREFIXES : [];

  let rawLines = [];
  if (fs.existsSync(ENV_PATH)) {
    rawLines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  }

  const keysUpdated = new Set();
  
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    
    const key = t.slice(0, idx).trim();
    
    if (prefixesToDelete.some(p => key.startsWith(p))) {
      rawLines[i] = '';
      delete process.env[key];
      continue;
    }

    if (payload.hasOwnProperty(key)) {
      let newVal = payload[key];
      if (newVal === '********') {
        newVal = currentEnv[key];
      }
      rawLines[i] = `${key}=${newVal}`;
      keysUpdated.add(key);
      process.env[key] = newVal;
    }
  }

  for (const [key, val] of Object.entries(payload)) {
    if (key === '_DELETE_PREFIXES') continue;
    if (!keysUpdated.has(key) && val !== '********') {
      rawLines.push(`${key}=${val}`);
      process.env[key] = val;
    }
  }

  const cleanLines = rawLines.filter(line => line !== '');

  try {
    fs.writeFileSync(ENV_PATH, cleanLines.join('\n'), 'utf8');
    
    if (requiresRestart) {
      if (process.env.ALLOW_PM2_RESTART === 'true') {
        res.json({ success: true, requiresRestart: true, message: 'Settings saved. Server is restarting...' });
        setTimeout(() => {
          console.log('[Settings] PM2 restart triggered.');
          const child = spawn('pm2', ['restart', 'mikrotik-dashboard', '--update-env'], { stdio: 'ignore', detached: true });
          child.unref();
        }, 1000);
      } else {
        res.json({ success: true, requiresRestart: true, message: 'Settings saved. Please restart the server manually.' });
      }
      return;
    }
    
    res.json({ success: true, requiresRestart: false, message: 'Pengaturan berhasil disimpan!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write configuration: ' + err.message });
  }
});

module.exports = router;
