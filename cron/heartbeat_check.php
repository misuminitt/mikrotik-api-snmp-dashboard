<?php
$configPath = __DIR__ . '/config.php';
if (!file_exists($configPath)) exit(1);
$cfg = require $configPath;

$stateFile = (string) $cfg['state_file'];
$timeout = (int) $cfg['timeout_seconds'];
$botToken = (string) $cfg['bot_token'];
$chatId = (string) $cfg['chat_id'];

$state = [
  'last_seen' => null,
  'last_status' => 'UNKNOWN',
  'down_sent' => false,
  'up_sent' => false,
];
if (file_exists($stateFile)) {
  $raw = file_get_contents($stateFile);
  $decoded = json_decode((string) $raw, true);
  if (is_array($decoded)) $state = array_merge($state, $decoded);
}

$now = time();
$lastSeenTs = $state['last_seen'] ? strtotime((string) $state['last_seen']) : false;
$isUp = $lastSeenTs && (($now - $lastSeenTs) <= $timeout);
$currentStatus = $isUp ? 'UP' : 'DOWN';

function sendTelegram($botToken, $chatId, $text) {
  if ($botToken === '' || $chatId === '') return false;
  $url = 'https://api.telegram.org/bot' . $botToken . '/sendMessage';
  $payload = json_encode(['chat_id' => $chatId, 'text' => $text], JSON_UNESCAPED_UNICODE);
  $ch = curl_init($url);
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_POST, true);
  curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
  curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
  curl_setopt($ch, CURLOPT_TIMEOUT, 10);
  curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return $code >= 200 && $code < 300;
}

if ($currentStatus === 'DOWN' && !$state['down_sent']) {
  sendTelegram($botToken, $chatId, '🚨 Internet lokasi DOWN. Heartbeat tidak diterima.');
  $state['down_sent'] = true;
  $state['up_sent'] = false;
}
if ($currentStatus === 'UP' && !$state['up_sent']) {
  sendTelegram($botToken, $chatId, '✅ Internet lokasi UP lagi. Heartbeat diterima kembali.');
  $state['up_sent'] = true;
  $state['down_sent'] = false;
}

$state['last_status'] = $currentStatus;
$state['checked_at'] = gmdate('c');
file_put_contents($stateFile, json_encode($state, JSON_PRETTY_PRINT));
