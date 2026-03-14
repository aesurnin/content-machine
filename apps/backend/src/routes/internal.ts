import { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { setFrame } from '../lib/live-preview-store.js';
import { appendVideoLog } from '../lib/video-logs-store.js';
import { uploadToR2 } from '../lib/r2.js';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';

const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';
if (!PREVIEW_SECRET) {
  console.warn('[internal] SCREENCAST_PREVIEW_SECRET is not set — live preview will not work');
}

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  const videoLimit = 500 * 1024 * 1024;
  fastify.addContentTypeParser('video/mp4', { parseAs: 'buffer', bodyLimit: videoLimit }, (req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser('video/webm', { parseAs: 'buffer', bodyLimit: videoLimit }, (req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: videoLimit }, (req, body, done) => {
    done(null, body);
  });

  fastify.post<{ Params: { videoId: string }; Body: { message?: string } }>('/logs/:videoId', { logLevel: 'silent' }, async (request, reply) => {
    if (!PREVIEW_SECRET || request.headers['x-preview-token'] !== PREVIEW_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { videoId } = request.params;
    const body = request.body as { message?: string } | string;
    const message = typeof body === 'object' && body?.message ? body.message : (typeof body === 'string' ? body : '');
    if (message) appendVideoLog(videoId, message);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { videoId: string } }>('/live-preview/:videoId', { logLevel: 'silent' }, async (request, reply) => {
    if (!PREVIEW_SECRET || request.headers['x-preview-token'] !== PREVIEW_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { videoId } = request.params;
    const body = request.body;
    if (!body || !Buffer.isBuffer(body)) return reply.status(400).send({ error: 'Expected JPEG body' });
    setFrame(videoId, body);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { videoId: string } }>('/upload-video/:videoId', { logLevel: 'silent' }, async (request, reply) => {
    if (!PREVIEW_SECRET || request.headers['x-preview-token'] !== PREVIEW_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { videoId } = request.params;
    const projectId = request.headers['x-project-id'];
    if (!projectId || typeof projectId !== 'string') return reply.status(400).send({ error: 'X-Project-Id required' });
    const body = request.body;
    if (!body || !Buffer.isBuffer(body)) return reply.status(400).send({ error: 'Expected video body' });
    const ct = request.headers['content-type'] || 'video/webm';
    const ext = ct.includes('mp4') ? '.mp4' : '.webm';
    const key = `projects/${projectId}/${videoId}/recording${ext}`;
    await uploadToR2(key, body, ct.includes('mp4') ? 'video/mp4' : 'video/webm');

    const originalReplayUrl = (request.headers['x-original-replay-url'] as string) || undefined;
    const [existing] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    const prevMeta = (existing?.metadata as Record<string, unknown>) || {};
    const replayUrl = originalReplayUrl ?? (typeof prevMeta.originalReplayUrl === 'string' ? prevMeta.originalReplayUrl : null)
      ?? (existing?.sourceUrl?.startsWith('http') ? existing.sourceUrl : null);
    const metadata = replayUrl ? { ...prevMeta, originalReplayUrl: replayUrl } : prevMeta;

    await db.update(videoEntities)
      .set({ status: 'ready', sourceUrl: key, metadata })
      .where(eq(videoEntities.id, videoId));
    return reply.send({ ok: true, key });
  });
};
