'use strict';
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], alertLog: [], hostnameAliases: {}, heartbeat: {} };
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.hostnameAliases || typeof db.hostnameAliases !== 'object') db.hostnameAliases = {};
    if (!db.heartbeat || typeof db.heartbeat !== 'object') db.heartbeat = {};
    return db;
  } catch (_) {
    return { users: [], alertLog: [], hostnameAliases: {}, heartbeat: {} };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

let _db = loadDB();
if (_db.users.length === 0) {
  const hash = bcrypt.hashSync('Admin@2Arah', 12);
  _db.users.push({
    id:            1,
    username:      'admin',
    password_hash: hash,
    role:          'admin',
    created_at:    new Date().toISOString(),
  });
  saveDB(_db);
  console.log('[DB] Default admin created.');
}

module.exports = {
  findUser(username) {
    const db = loadDB();
    return db.users.find(u => u.username === username) || null;
  },

  verifyPassword(plain, hash) {
    return bcrypt.compareSync(plain, hash);
  },

  logAlert(type, routerIp, message) {
    const db = loadDB();
    db.alertLog.push({
      id:       Date.now(),
      type,
      router_ip: routerIp,
      message,
      sent_at:  new Date().toISOString(),
    });
    if (db.alertLog.length > 200) db.alertLog = db.alertLog.slice(-200);
    saveDB(db);
  },

  getRecentAlerts() {
    const db = loadDB();
    return [...db.alertLog].reverse().slice(0, 50);
  },

  getAliases() {
    const db = loadDB();
    return db.hostnameAliases || {};
  },

  setAlias(ip, alias) {
    const db = loadDB();
    if (!db.hostnameAliases || typeof db.hostnameAliases !== 'object') db.hostnameAliases = {};
    if (!alias) {
      delete db.hostnameAliases[ip];
    } else {
      db.hostnameAliases[ip] = alias;
    }
    saveDB(db);
  },

  getHeartbeatState() {
    const db = loadDB();
    const state = db.heartbeat || {};
    return {
      lastSeenAt: state.lastSeenAt || null,
      lastStatus: state.lastStatus || null,
      lastTransitionAt: state.lastTransitionAt || null,
      lastNotificationAt: state.lastNotificationAt || null,
      secret: state.secret || null,
    };
  },

  setHeartbeatState(nextState) {
    const db = loadDB();
    const prev = db.heartbeat && typeof db.heartbeat === 'object' ? db.heartbeat : {};
    db.heartbeat = { ...prev, ...nextState };
    saveDB(db);
    return db.heartbeat;
  },
};
