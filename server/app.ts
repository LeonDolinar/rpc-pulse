import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { BenchmarkRunner } from './benchmark/runner.js';
import type { EngineDeps } from './benchmark/engine.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { registerRoutes } from './api/routes.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
  runner: BenchmarkRunner;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildAppOptions {
  db: Db;
  config: AppConfig;
  logger?: boolean | object;
  engineDeps?: EngineDeps;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 64 * 1024,
    logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== 'true' }),
  });

  const runner = new BenchmarkRunner({
    db: opts.db,
    secrets: { key: opts.config.secretKey, allowPrivateNetworks: opts.config.allowPrivateNetworks },
    logger: app.log,
    deps: opts.engineDeps,
  });
  app.decorate('ctx', { db: opts.db, config: opts.config, runner });
  app.addHook('onClose', async () => runner.stop());

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        details: err.issues,
      });
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    const status = statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: message }, 'request failed');
      return reply.status(500).send({ error: 'Internal server error' });
    }
    return reply.status(status).send({ error: message ?? 'Request failed' });
  });

  await app.register(registerRoutes, { prefix: '/api' });

  // Serve the built frontend in production; the Vite dev server handles it in development.
  if (fs.existsSync(path.join(opts.config.webDistPath, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.config.webDistPath });
    app.setNotFoundHandler((req, reply) => {
      // Only extension-less GETs are client-side routes; missing assets must 404, not return HTML.
      const pathname = req.url.split('?')[0]!;
      if (req.method !== 'GET' || pathname.startsWith('/api/') || /\.[a-z0-9]+$/i.test(pathname)) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
