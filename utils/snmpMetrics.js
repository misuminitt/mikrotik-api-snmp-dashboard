'use strict';

const snmp = require('net-snmp');

const OID = {
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  hrProcessorLoadBase: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageDescrBase: '1.3.6.1.2.1.25.2.3.1.3',
  hrStorageAllocUnitsBase: '1.3.6.1.2.1.25.2.3.1.4',
  hrStorageSizeBase: '1.3.6.1.2.1.25.2.3.1.5',
  hrStorageUsedBase: '1.3.6.1.2.1.25.2.3.1.6',
  ifNameBase: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctetsBase: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctetsBase: '1.3.6.1.2.1.31.1.1.1.10',
  ifOperStatusBase: '1.3.6.1.2.1.2.2.1.8',
  mtxrBoardTemp: '1.3.6.1.4.1.14988.1.1.3.10.0',
  mtxrCpuTemp: '1.3.6.1.4.1.14988.1.1.3.11.0',
  mtxrVoltage: '1.3.6.1.4.1.14988.1.1.3.8.0',
};

const trafficCache = new Map();

function parseRouterHost(routerIp) {
  if (!routerIp) return null;
  const [host, portRaw] = routerIp.includes(':') ? routerIp.split(':') : [routerIp, '161'];
  return { host, port: parseInt(portRaw, 10) || 161 };
}

function buildSession(routerIp) {
  const parsed = parseRouterHost(routerIp);
  if (!parsed) throw new Error('Router host tidak valid');

  const community = process.env.SNMP_COMMUNITY || process.env.MIKROTIK_SNMP_COMMUNITY || 'public';
  const timeout = parseInt(process.env.SNMP_TIMEOUT_MS || '2500', 10);
  const retries = parseInt(process.env.SNMP_RETRIES || '1', 10);

  const version = (process.env.SNMP_VERSION || '2c').toLowerCase() === '1'
    ? snmp.Version1
    : snmp.Version2c;

  return snmp.createSession(parsed.host, community, {
    port: parsed.port === 8080 ? 161 : parsed.port,
    version,
    timeout,
    retries,
  });
}

function getOne(session, oid) {
  return new Promise((resolve, reject) => {
    session.get([oid], (err, varbinds) => {
      if (err) return reject(err);
      if (!varbinds || !varbinds[0] || snmp.isVarbindError(varbinds[0])) {
        return reject(new Error('OID not available: ' + oid));
      }
      resolve(varbinds[0].value);
    });
  });
}

function walk(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = [];
    session.subtree(baseOid, (varbind) => {
      if (!snmp.isVarbindError(varbind)) out.push(varbind);
    }, (err) => {
      if (err) return reject(err);
      resolve(out);
    });
  });
}

function ticksToUptime(ticks) {
  const totalSec = Math.floor((Number(ticks) || 0) / 100);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${d}d${h}h${m}m${s}s`;
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function oidSuffix(oid, base) {
  return oid.slice(base.length + 1);
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function findRamIndex(descrRows) {
  const ram = descrRows.find(v => {
    const txt = String(v.value || '').toLowerCase();
    return txt.includes('memory') || txt.includes('ram') || txt.includes('main memory');
  });
  return ram ? oidSuffix(ram.oid, OID.hrStorageDescrBase) : null;
}

async function getResourceMetrics(routerIp) {
  const session = buildSession(routerIp);
  try {
    const [uptimeTicks, cpuRows, descrRows] = await Promise.all([
      getOne(session, OID.sysUpTime),
      walk(session, OID.hrProcessorLoadBase),
      walk(session, OID.hrStorageDescrBase),
    ]);

    const cpuLoad = Math.round(average(cpuRows.map(v => asNumber(v.value))));
    const ramIdx = findRamIndex(descrRows);

    let totalMemory = 0;
    let freeMemory = 0;

    if (ramIdx) {
      const [allocUnit, sizeUnits, usedUnits] = await Promise.all([
        getOne(session, `${OID.hrStorageAllocUnitsBase}.${ramIdx}`),
        getOne(session, `${OID.hrStorageSizeBase}.${ramIdx}`),
        getOne(session, `${OID.hrStorageUsedBase}.${ramIdx}`),
      ]);

      const unit = asNumber(allocUnit);
      totalMemory = asNumber(sizeUnits) * unit;
      const usedMemory = asNumber(usedUnits) * unit;
      freeMemory = Math.max(0, totalMemory - usedMemory);
    }

    return {
      'cpu-load': cpuLoad,
      'total-memory': totalMemory,
      'free-memory': freeMemory,
      'uptime': ticksToUptime(uptimeTicks),
    };
  } finally {
    session.close();
  }
}

async function getHealthMetrics(routerIp) {
  const session = buildSession(routerIp);
  try {
    const names = [
      ['board-temperature', OID.mtxrBoardTemp],
      ['cpu-temperature', OID.mtxrCpuTemp],
      ['voltage', OID.mtxrVoltage],
    ];

    const entries = await Promise.all(names.map(async ([name, oid]) => {
      try {
        const v = await getOne(session, oid);
        return { name, value: String(v) };
      } catch (_) {
        return null;
      }
    }));

    return entries.filter(Boolean);
  } finally {
    session.close();
  }
}

async function getTrafficMetrics(routerIp) {
  const session = buildSession(routerIp);
  try {
    const [ifNames, inRows, outRows, operRows] = await Promise.all([
      walk(session, OID.ifNameBase),
      walk(session, OID.ifHCInOctetsBase),
      walk(session, OID.ifHCOutOctetsBase),
      walk(session, OID.ifOperStatusBase).catch(() => []),
    ]);

    const nameMap = new Map();
    ifNames.forEach(v => nameMap.set(oidSuffix(v.oid, OID.ifNameBase), String(v.value)));

    const inMap = new Map();
    inRows.forEach(v => inMap.set(oidSuffix(v.oid, OID.ifHCInOctetsBase), asNumber(v.value)));

    const outMap = new Map();
    outRows.forEach(v => outMap.set(oidSuffix(v.oid, OID.ifHCOutOctetsBase), asNumber(v.value)));

    const operMap = new Map();
    operRows.forEach(v => operMap.set(oidSuffix(v.oid, OID.ifOperStatusBase), asNumber(v.value)));

    const now = Date.now();
    const prev = trafficCache.get(routerIp);
    const result = [];

    for (const [idx, name] of nameMap.entries()) {
      const running = (operMap.get(idx) || 0) === 1;
      const rxOctets = inMap.get(idx) || 0;
      const txOctets = outMap.get(idx) || 0;

      let rxBps = 0;
      let txBps = 0;

      if (prev && prev.ts && prev.data[idx]) {
        const dt = (now - prev.ts) / 1000;
        if (dt > 0) {
          const dIn = rxOctets - prev.data[idx].in;
          const dOut = txOctets - prev.data[idx].out;
          if (dIn >= 0) rxBps = (dIn * 8) / dt;
          if (dOut >= 0) txBps = (dOut * 8) / dt;
        }
      }

      result.push({
        name,
        running,
        'rx-bits-per-second': Math.max(0, Math.round(rxBps)),
        'tx-bits-per-second': Math.max(0, Math.round(txBps)),
      });
    }

    const snap = {};
    for (const idx of nameMap.keys()) {
      snap[idx] = { in: inMap.get(idx) || 0, out: outMap.get(idx) || 0 };
    }
    trafficCache.set(routerIp, { ts: now, data: snap });

    return result;
  } finally {
    session.close();
  }
}

module.exports = {
  getResourceMetrics,
  getHealthMetrics,
  getTrafficMetrics,
};
