// PM2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'alice-ai-hermes-proxy',
      script: 'src/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      env_file: '.env', // PM2 >= 5.4 читает .env; либо используйте dotenv / --env-file
    },
  ],
};
