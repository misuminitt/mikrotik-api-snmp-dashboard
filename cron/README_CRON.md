# Cron Heartbeat Mode (Shared Hosting)

Mode ini dipakai tanpa Node.js web dashboard. Hanya pakai PHP + cron.

## 1) Setup file config
```bash
cp cron/config.sample.php cron/config.php
```
Lalu isi:
- `secret`
- `timeout_seconds` (contoh `300`)
- `bot_token`
- `chat_id`

## 2) Publish endpoint ping
Upload `cron/heartbeat_ping.php` dan `cron/config.php` ke path publik acak, contoh:
`/public_html/hb-ping-random.php`

Contoh scheduler MikroTik:
```routeros
/tool fetch url="https://domainkamu.com/hb-ping-random.php?secret=ISI_SECRET" keep-result=no
```

## 3) Pasang cron checker di server
Jalankan tiap menit:
```cron
* * * * * /usr/local/bin/php /home/USER/public_html/cron/heartbeat_check.php >/dev/null 2>&1
```

## 4) Alert behavior
- Heartbeat telat melewati `timeout_seconds` -> kirim `DOWN` sekali.
- Saat heartbeat masuk lagi -> kirim `UP` sekali.
