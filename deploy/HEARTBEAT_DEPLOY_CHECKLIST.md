# Heartbeat Deploy Checklist (Shared Hosting / VPS)

## 1) Wajib set secret tetap di `.env`
- Pastikan ada:
  - `HEARTBEAT_SECRET=<random panjang>`
- Jangan kosongkan nilai ini.

## 2) Jalankan app dengan process manager
- Rekomendasi utama: `pm2`
- Alternatif: `systemd`
- Jangan jalankan `node server.js` biasa untuk produksi.

## 3) Reverse proxy + firewall
- Expose domain publik ke app Node:
  - `https://domainkamu.com/heartbeat/ping.php?secret=...`
- Allow inbound ke reverse proxy (80/443).
- Forward internal ke `127.0.0.1:3000` (atau port app yang dipakai).
- Jangan expose port internal app langsung ke internet.

Contoh Nginx location:
```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 4) Scheduler dari sisi router/lokasi
- Pasang scheduler 1 menit:
```routeros
/tool fetch url="https://domainkamu.com/heartbeat/ping.php?secret=GANTI_SECRET" keep-result=no
```

## 5) Verifikasi cepat
- Cek status endpoint:
  - `GET /heartbeat/status`
- Harus terlihat `status: UP` setelah scheduler aktif.
- Jika tidak ada heartbeat melewati timeout, status harus pindah `DOWN` dan kirim Telegram.
