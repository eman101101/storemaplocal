import './env.js'; // loads backend/.env before anything reads process.env
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';

const app = createApp();
// Set before listening so req.ip respects the platform's TLS proxy.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

const server = app.listen(config.port, () => {
  console.log(`StoreMap listening on ${config.publicBaseUrl} (port ${config.port})`);
  console.log(`  dev login: ${config.devLogin ? 'enabled' : 'disabled'}`);
});

// Local mode: seed the demo maps on first boot so a fresh one-click deploy
// is immediately explorable (SEED_DEMO=false to skip).
if (config.selfHosted && config.seedDemo && db.prepare('SELECT COUNT(*) n FROM stores').get().n === 0) {
  console.log('[boot] empty database — seeding demo maps (SEED_DEMO=false to disable)');
  const seedPath = fileURLToPath(new URL('../scripts/seed-demo.mjs', import.meta.url));
  spawn(process.execPath, [seedPath], { stdio: 'inherit', env: process.env }).on('exit', (code) =>
    console.log(`[boot] demo seed ${code === 0 ? 'complete' : 'failed'} (${code})`)
  );
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
