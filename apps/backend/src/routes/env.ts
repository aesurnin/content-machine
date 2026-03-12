import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { appEnv } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { refreshAppEnvInProcess } from '../lib/env-store.js';

const envRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /** List app env variable keys only (values never exposed for security) */
  fastify.get('/', async (_request, reply) => {
    const rows = await db.select({ key: appEnv.key }).from(appEnv).orderBy(appEnv.key);
    return reply.send(rows.map((r) => ({ key: r.key })));
  });

  /** Set or create a variable. Body: { key: string, value: string } */
  fastify.post('/', async (request, reply) => {
    const schema = z.object({
      key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Key must be a valid env name (letters, numbers, underscore)'),
      value: z.string(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const { key, value } = body.data;
    await db
      .insert(appEnv)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appEnv.key,
        set: { value },
      });
    await refreshAppEnvInProcess();
    return reply.status(201).send({ key });
  });

  /** Delete a variable */
  fastify.delete<{ Params: { key: string } }>('/:key', async (request, reply) => {
    const { key } = request.params;
    const decoded = decodeURIComponent(key);
    const result = await db.delete(appEnv).where(eq(appEnv.key, decoded)).returning({ key: appEnv.key });
    if (result.length > 0) {
      await refreshAppEnvInProcess();
    }
    return reply.status(204).send();
  });
};

export default envRoutes;
