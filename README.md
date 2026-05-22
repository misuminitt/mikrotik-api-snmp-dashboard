<h1 align="center">mikrotik-api-snmp-dashboard</h1>

<p align="center">
  <img src="https://img.shields.io/badge/node.js-18+-339933.svg">
  <img src="https://img.shields.io/badge/express-4-000000.svg">
  <img src="https://img.shields.io/badge/routeros-rest%20%2B%20snmp-14988-0ea5e9.svg">
  <img src="https://img.shields.io/badge/status-active-success.svg">
</p>

A MikroTik network operations dashboard focused on real-time traffic monitoring, health telemetry, DHCP/connection visibility, firewall and log insights, plus Telegram alerting.

## Technology Stack
- `node.js`
- `express`
- `node-fetch`
- `net-snmp`
- `express-session`

## Requirements
- Node.js 18+
- npm
- MikroTik RouterOS v7 with REST API enabled
- SNMP enabled on router (for lightweight periodic metrics)
- Telegram Bot Token + Chat ID (optional, for alerts)

## Installation
### 1. Clone repository
```bash
git clone https://github.com/misuminitt/mikrotik-api-snmp-dashboard.git
cd mikrotik-api-snmp-dashboard
```

### 2. Install dependencies
```bash
npm install
```

### 3. Setup environment
```bash
cp .env.example .env
```

Make sure these values are set in `.env`:
- `MIKROTIK_USER`
- `MIKROTIK_PASS`
- `MIKROTIK_PORT` (default `8080`)
- `SNMP_COMMUNITY` (default `public`)
- `SNMP_VERSION` (default `2c`)
- `SESSION_SECRET`
- `TELEGRAM_BOT_TOKEN` (optional)
- `TELEGRAM_CHAT_ID` (optional)

## Usage
Run server:
```bash
npm start
```

Development mode:
```bash
npm run dev
```

Main features:
- Dashboard real-time RX/TX + CPU/Memory/Uptime/Temperature/Voltage
- IP Usage (real-time) with Internet row pinned on top
- DHCP Leases and Active Connections views
- Firewall stats and system logs viewer
- DNS cache monitoring
- History and threshold alert timeline
- Heartbeat monitoring (push mode for CGNAT sites) with DOWN/UP transition alerts
- Hybrid data mode: SNMP for lightweight periodic metrics, REST API for detailed operational data

## Shared Hosting (Cron-Only)
Jika shared hosting tidak stabil untuk publish Node.js app, gunakan mode heartbeat berbasis PHP+cron.

Lihat panduan:
- `cron/README_CRON.md`

## Author
misuminitt
