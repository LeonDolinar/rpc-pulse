import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, seedNetworks } from './db/client.js';
import { markOrphanedRunsInterrupted, purgeSamplesOlderThan } from './repositories/runs.js';
import { getSettings } from './repositories/settings.js';

const RETENTION_INTERVAL_MS = 6 * 3600_000;

async function main() {
  const config = loadConfig();
  const { db, sqlite } = openDatabase(config.databasePath);
  seedNetworks(db);

  const app = await buildApp({ db, config });
  if (config.secretKeySource === 'file') {
    app.log.warn('RPC_PULSE_SECRET_KEY not set; using a key file next to the database. Set the env var in production.');
  }
  if (config.allowPrivateNetworks) {
    app.log.warn('ALLOW_PRIVATE_NETWORKS is enabled: endpoints may target private and loopback addresses.');
  }

  const interrupted = markOrphanedRunsInterrupted(db);
  if (interrupted > 0) app.log.warn({ count: interrupted }, 'marked runs interrupted by previous shutdown');

  const applyRetention = () => {
    const days = getSettings(db).retention.sampleDays;
    if (days <= 0) return;
    const removed = purgeSamplesOlderThan(db, Date.now() - days * 86_400_000);
    if (removed > 0) app.log.info({ removed, days }, 'purged old request samples');
  };
  applyRetention();
  const retentionTimer = setInterval(applyRetention, RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  await app.listen({ host: config.host, port: config.port });
  app.ctx.runner.kick();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(retentionTimer);
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
