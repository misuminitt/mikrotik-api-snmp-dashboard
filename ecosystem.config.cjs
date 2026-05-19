module.exports = {
  apps: [
    {
      name: 'mikrotik-dashboard',
      script: 'server.js',
      cwd: '/home/pony3437/mikrotik-dashboard',
      interpreter: '/opt/alt/alt-nodejs18/root/usr/bin/node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/home/pony3437/logs/mikrotik-dashboard.out.log',
      error_file: '/home/pony3437/logs/mikrotik-dashboard.err.log',
      time: true,
    },
  ],
};
