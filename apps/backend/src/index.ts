import './load-env.js';
import { db } from './db/index.js';
import { providerTemplates } from './db/schema/index.js';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { lucia } from './lib/auth.js';
import { isR2Configured } from './lib/r2.js';
import { seedAuthUsers } from './lib/seed-auth.js';

if (!isR2Configured()) {
  console.error('Fatal: R2 storage is required. Set R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env');
  process.exit(1);
}

const server: FastifyInstance = Fastify({
  logger: true,
  disableRequestLogging: true,
});

server.register(cors, { 
  origin: true,
  credentials: true,
});

server.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

// Middleware to populate session
server.addHook('preHandler', async (request, reply) => {
  const sessionId = lucia.readSessionCookie(request.headers.cookie ?? "");
  if (!sessionId) {
    request.user = null;
    request.session = null;
    return;
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (session && session.fresh) {
    const sessionCookie = lucia.createSessionCookie(session.id);
    reply.header('Set-Cookie', sessionCookie.serialize());
  }
  if (!session) {
    const sessionCookie = lucia.createBlankSessionCookie();
    reply.header('Set-Cookie', sessionCookie.serialize());
  }
  request.user = user;
  request.session = session;
});

// Routes
import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import providersRoutes from './routes/providers.js';
import queueRoutes from './routes/queue.js';
import workflowsRoutes from './routes/workflows.js';
import contentLibraryRoutes from './routes/content-library.js';
import { internalRoutes } from './routes/internal.js';
import envRoutes from './routes/env.js';
import { startWorkflowWorker } from './workers/workflow.js';
import { loadAppEnvIntoProcess } from './lib/env-store.js';
import { checkRedisConnection } from './lib/queue.js';
server.register(authRoutes, { prefix: '/auth' });
server.register(projectsRoutes, { prefix: '/projects' });
server.register(providersRoutes, { prefix: '/providers' });
server.register(queueRoutes, { prefix: '/queue' });
server.register(workflowsRoutes, { prefix: '/workflows' });
server.register(contentLibraryRoutes, { prefix: '/content-library' });
server.register(internalRoutes, { prefix: '/internal' });
server.register(envRoutes, { prefix: '/env' });

server.get('/ping', async (request, reply) => {
  return { pong: 'it works!' };
});

server.get('/health', async (request, reply) => {
  const redis = await checkRedisConnection();
  return {
    redis: redis.ok ? 'ok' : 'error',
    redisError: redis.error,
  };
});

server.get('/config', async (request, reply) => {
  const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
  return { durationLimit };
});

async function seedProviderTemplates() {
  const existing = await db.select().from(providerTemplates);
  const hasBGaming = existing.some((t) => t.urlPattern.toLowerCase().includes('bgaming'));
  const hasRowzones = existing.some((t) => t.urlPattern.toLowerCase().includes('rowzones'));

  if (!hasBGaming) {
    await db.insert(providerTemplates).values({
      name: 'BGaming',
      urlPattern: 'bgaming-network.com',
      playSelectors: ['#playBtn', 'button#playBtn', '[class*="replay"]'],
      endSelectors: [],
      idleValueSelector: '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]',
      idleSeconds: 40,
      consoleEndPatterns: [],
    });
    console.log('[Seed] Added BGaming provider template');
  }
  if (!hasRowzones) {
    await db.insert(providerTemplates).values({
      name: 'Rowzones',
      urlPattern: 'rowzones.com',
      playSelectors: [], // Animation starts immediately, no play button
      endSelectors: ['[class*="replay-summary"]', '[class*="ReplaySummary"]', '[class*="summary"]'],
      idleValueSelector: undefined,
      idleSeconds: 40,
      consoleEndPatterns: ['shell:modal:active'], // Console log when demo ends and modal appears
    });
    console.log('[Seed] Added Rowzones provider template');
  }
  const hasRowzonesStaticR2 = existing.some((t) => t.urlPattern.toLowerCase().includes('static-r2-fr.rowzones'));
  if (!hasRowzonesStaticR2) {
    await db.insert(providerTemplates).values({
      name: 'Rowzones (static-r2-fr)',
      urlPattern: 'static-r2-fr.rowzones.com',
      playSelectors: [], // Animation starts immediately, no play button
      endSelectors: ['[class*="replay-summary"]', '[class*="ReplaySummary"]', '[class*="summary"]'],
      idleValueSelector: undefined,
      idleSeconds: 40,
      consoleEndPatterns: ['shell:modal:active'],
    });
    console.log('[Seed] Added Rowzones static-r2-fr provider template');
  }
}

const start = async () => {
  try {
    await seedAuthUsers();
    await seedProviderTemplates();
    await loadAppEnvIntoProcess();

    const redis = await checkRedisConnection();
    if (!redis.ok) {
      console.error('[Startup] Redis unreachable:', redis.error);
      console.error('[Startup] Workflow jobs will fail. Ensure Redis is running (docker-compose up redis)');
    } else {
      console.log('[Startup] Redis OK');
    }

    const port = parseInt(process.env.PORT || '3000', 10);
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on ${server.server.address()}`);
    startWorkflowWorker();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};
start();

declare module 'fastify' {
  interface FastifyRequest {
    user: any;
    session: any;
  }
}
