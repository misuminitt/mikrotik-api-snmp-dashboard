<?php
header('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet', true);
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0', true);
header('Content-Type: application/json');

$configPath = __DIR__ . '/config.php';
if (!file_exists($configPath)) {
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'missing config.php']);
  exit;
}
$cfg = require $configPath;

$secret = isset($_GET['secret']) ? (string) $_GET['secret'] : '';
if ($secret === '' || !hash_equals((string) $cfg['secret'], $secret)) {
  http_response_code(403);
  echo json_encode(['ok' => false, 'error' => 'forbidden']);
  exit;
}

$stateFile = (string) $cfg['state_file'];
$state = [];
if (file_exists($stateFile)) {
  $raw = file_get_contents($stateFile);
  $decoded = json_decode((string) $raw, true);
  if (is_array($decoded)) $state = $decoded;
}

$now = gmdate('c');
$state['last_seen'] = $now;
if (!isset($state['last_status'])) $state['last_status'] = 'UP';
if (!isset($state['down_sent'])) $state['down_sent'] = false;
if (!isset($state['up_sent'])) $state['up_sent'] = true;

file_put_contents($stateFile, json_encode($state, JSON_PRETTY_PRINT));
echo json_encode(['ok' => true, 'last_seen' => $now]);
