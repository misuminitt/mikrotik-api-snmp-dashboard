'use strict';
const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();
const {
  getResourceMetrics,
  getHealthMetrics,
  getTrafficMetrics,
} = require('../utils/snmpMetrics');

const MT_USER = process.env.MIKROTIK_USER;
const MT_PASS = process.env.MIKROTIK_PASS;

function buildAuthHeader() {
  return 'Basic ' + Buffer.from(`${MT_USER}:${MT_PASS}`).toString('base64');
}

async function mikrotikFetch(routerIp, path, options = {}) {
  const [host, port] = routerIp.includes(':') ? routerIp.split(':') : [routerIp, '80'];
  const url = `http://${host}:${port}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': buildAuthHeader(),
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
    timeout: 8000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RouterOS ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
}
router.get('/status', async (req, res) => {
  const routerIp = req.session.routerIp;
  try {
    await mikrotikFetch(routerIp, '/rest/system/identity');
    return res.json({ online: true, routerIp });
  } catch (err) {
    return res.json({ online: false, routerIp, error: err.message });
  }
});
router.get('/resources', async (req, res) => {
  try {
    let data;
    try {
      data = await getResourceMetrics(req.session.routerIp);
    } catch (_) {
      data = await mikrotikFetch(req.session.routerIp, '/rest/system/resource');
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/health', async (req, res) => {
  try {
    let data;
    try {
      const snmpData = await getHealthMetrics(req.session.routerIp);
      const restData = await mikrotikFetch(req.session.routerIp, '/rest/system/health').catch(() => []);

      if (!Array.isArray(snmpData) || snmpData.length === 0) {
        data = restData;
      } else if (Array.isArray(restData) && restData.length > 0) {
        const byName = new Map();
        for (const item of restData) {
          if (!item || !item.name) continue;
          byName.set(String(item.name).toLowerCase(), item);
        }
        for (const item of snmpData) {
          if (!item || !item.name) continue;
          byName.set(String(item.name).toLowerCase(), item);
        }
        data = Array.from(byName.values());
      } else {
        data = snmpData;
      }
    } catch (_) {
      data = await mikrotikFetch(req.session.routerIp, '/rest/system/health');
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/interfaces', async (req, res) => {
  try {
    const [ifaces, stats] = await Promise.all([
      mikrotikFetch(req.session.routerIp, '/rest/interface'),
      mikrotikFetch(req.session.routerIp, '/rest/interface/print?stats=true').catch(() => []),
    ]);
    return res.json({ ifaces, stats });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.post('/traffic', async (req, res) => {
  try {
    let data;
    try {
      data = await getTrafficMetrics(req.session.routerIp);
    } catch (_) {
      const ifaces = await mikrotikFetch(req.session.routerIp, '/rest/interface?running=true');
      const names  = ifaces.map(i => i.name).join(',');
      if (!names) return res.json([]);
      data = await mikrotikFetch(req.session.routerIp, '/rest/interface/monitor-traffic', {
        method: 'POST',
        body: JSON.stringify({ interface: names, duration: '1s', 'once': '' }),
      });
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/dhcp-leases', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/ip/dhcp-server/lease');
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/connections', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/ip/firewall/connection');
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/queues', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/queue/simple');
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/arp', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/ip/arp');
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/firewall-stats', async (req, res) => {
  try {
    const [filter, nat, mangle] = await Promise.all([
      mikrotikFetch(req.session.routerIp, '/rest/ip/firewall/filter').catch(() => []),
      mikrotikFetch(req.session.routerIp, '/rest/ip/firewall/nat').catch(() => []),
      mikrotikFetch(req.session.routerIp, '/rest/ip/firewall/mangle').catch(() => []),
    ]);
    return res.json({ filter: Array.isArray(filter) ? filter : [], nat: Array.isArray(nat) ? nat : [], mangle: Array.isArray(mangle) ? mangle : [] });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/logs', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/log');
    const logs = Array.isArray(data) ? data : [];
    return res.json(logs.slice(-200).reverse());
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
router.get('/dns-cache', async (req, res) => {
  try {
    const data = await mikrotikFetch(req.session.routerIp, '/rest/ip/dns/cache');
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

module.exports = { router, mikrotikFetch };
