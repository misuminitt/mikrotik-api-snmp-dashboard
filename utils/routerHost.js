'use strict';

const os = require('os');
const { execSync } = require('child_process');

function firstNonInternalIPv4() {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs || []) {
      if (a && a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function gatewayFromDefaultRoute() {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('route -n get default', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/gateway:\s*([^\s]+)/i);
      if (m && m[1]) return m[1].trim();
      return null;
    }

    if (process.platform === 'linux') {
      const out = execSync('ip route show default', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/default\s+via\s+([^\s]+)/i);
      if (m && m[1]) return m[1].trim();
      return null;
    }
  } catch (_) {}

  return null;
}

function fallbackGatewayFromLocalIp(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

function normalizeHostWithPort(host, port) {
  if (!host) return null;
  if (host.includes(':')) return host;
  return `${host}:${port}`;
}

function resolveRouterHost() {
  const configured = (process.env.MIKROTIK_HOST || '').trim();
  const configuredPort = (process.env.MIKROTIK_PORT || '').trim();
  const forced = (process.env.MIKROTIK_HOST_FORCE || '').trim();
  if (forced) return forced;

  const port = configuredPort || (configured.includes(':') ? configured.split(':')[1] : '') || '8080';

  const gw = gatewayFromDefaultRoute();
  if (gw) return normalizeHostWithPort(gw, port);

  const localIp = firstNonInternalIPv4();
  const guessedGw = fallbackGatewayFromLocalIp(localIp);
  if (guessedGw) return normalizeHostWithPort(guessedGw, port);
  return `192.168.20.1:${port}`;
}

module.exports = { resolveRouterHost };
