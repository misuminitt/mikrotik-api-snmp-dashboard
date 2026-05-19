'use strict';
const express = require('express');
const { findUser, verifyPassword } = require('../db/database');
const { resolveRouterHost } = require('../utils/routerHost');
const router = express.Router();
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  const user = findUser(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah.' });
  }
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;
  req.session.routerIp = resolveRouterHost();

  return res.json({
    ok: true,
    username: user.username,
    role: user.role,
    routerIp: req.session.routerIp,
  });
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({
    ok: true,
    username: req.session.username,
    role: req.session.role,
    routerIp: req.session.routerIp,
  });
});

module.exports = router;
