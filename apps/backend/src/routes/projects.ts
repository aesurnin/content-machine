import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { db } from '../db/index.js';
import { projects, providerTemplates, videoEntities } from '../db/schema/index.js';
import { and, eq, count } from 'drizzle-orm';
import z from 'zod';
import { uploadToR2, deleteFromR2, deleteMultipleFromR2, deletePrefixFromR2, getPresignedUrl, listObjectsWithMetaFromR2, streamObjectFromR2 } from '../lib/r2.js';
import fs from 'fs';
import { cleanupWorkflowModuleCache, ensureWorkflowModuleCacheDirs, listWorkflowModuleCache, listWorkflowCacheFolderContents, getWorkflowCacheFilePath, readWorkflowModuleMetadata, readWorkflowModuleSlots } from '../lib/workflow/runner.js';
import { ensurePricingLoaded, calculateCost } from '../lib/workflow/openrouter-pricing.js';
import { generateScenarioPreview } from '../lib/workflow/modules/llm-scenario-generator.js';
import { resolveWorkflowVariablesForApi, findOutputInCacheDir } from '../lib/workflow/variable-resolver.js';
import { getModule } from '../lib/workflow/registry.js';
import { addScreencastJob, removeScreencastJobByVideoId } from '../lib/queue.js';
import { listJobs } from '../lib/workflow-job-store.js';
import { getFrame, clearFrame } from '../lib/live-preview-store.js';
import { getVideoLogs } from '../lib/video-logs-store.js';

async function resolveProviderForUrl(url: string) {
  let host: string;
  try {
    host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const templates = await db.select().from(providerTemplates);
  const matches = templates.filter((t) => host.includes(t.urlPattern.toLowerCase()));
  // Prefer longer (more specific) urlPattern match, e.g. static-r2-fr.rowzones.com over rowzones.com
  return matches.sort((a, b) => b.urlPattern.length - a.urlPattern.length)[0] ?? null;
}

async function enqueueScreencastJobForUrl(
  projectId: string,
  videoId: string,
  url: string
): Promise<void> {
  const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
  const provider = await resolveProviderForUrl(url);

  let endSelectors: string[] | undefined;
  let playSelectors: string[] | undefined;
  let skipPlayClick: boolean | undefined;
  let idleValueSelector: string | undefined;
  let idleSeconds: number | undefined;
  let consoleEndPatterns: string[] | undefined;

  if (provider) {
    playSelectors = (provider.playSelectors as string[])?.length ? (provider.playSelectors as string[]) : undefined;
    endSelectors = (provider.endSelectors as string[])?.length ? (provider.endSelectors as string[]) : undefined;
    idleValueSelector = provider.idleValueSelector ?? undefined;
    idleSeconds = provider.idleSeconds ?? 40;
    consoleEndPatterns = (provider.consoleEndPatterns as string[])?.length ? (provider.consoleEndPatterns as string[]) : undefined;
    skipPlayClick = (provider as { skipPlayClick?: boolean }).skipPlayClick;
  }
  if (!playSelectors?.length) {
    try {
      const s = process.env.SCREENCAST_PLAY_SELECTORS;
      if (s) playSelectors = JSON.parse(s) as string[];
    } catch { /* ignore */ }
  }
  if (!endSelectors?.length) {
    try {
      const s = process.env.SCREENCAST_END_SELECTORS;
      if (s) endSelectors = JSON.parse(s) as string[];
    } catch { /* ignore */ }
  }
  if (!idleValueSelector) {
    const s = process.env.SCREENCAST_IDLE_SELECTOR;
    if (s) idleValueSelector = s;
  }
  if (idleSeconds == null) {
    const s = process.env.SCREENCAST_IDLE_SECONDS;
    if (s) idleSeconds = parseInt(s, 10);
  }
  if (!consoleEndPatterns?.length) {
    try {
      const s = process.env.SCREENCAST_CONSOLE_END_PATTERNS;
      if (s) consoleEndPatterns = JSON.parse(s) as string[];
    } catch { /* ignore */ }
  }
  if (url.includes('bgaming-network.com') && !provider) {
    if (!playSelectors?.length) playSelectors = ['#playBtn', 'button#playBtn', '[class*="replay"]'];
    if (!idleValueSelector) idleValueSelector = '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]';
    if (idleSeconds == null) idleSeconds = 40;
  }
  if (url.includes('rowzones.com')) {
    if (!playSelectors?.length) playSelectors = [];
    if (!endSelectors?.length) endSelectors = ['[class*="replay-summary"]', '[class*="ReplaySummary"]', '[class*="summary"]'];
    if (!consoleEndPatterns?.length) consoleEndPatterns = ['shell:modal:active'];
    skipPlayClick = true;
  }

  const [existing] = await db.select({ metadata: videoEntities.metadata })
    .from(videoEntities)
    .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
  const prevMeta = existing?.metadata != null && typeof existing.metadata === 'object'
    ? (existing.metadata as Record<string, unknown>)
    : {};
  const metadata = {
    ...prevMeta,
    originalReplayUrl: url,
    recordingStartedAt: new Date().toISOString(),
  };
  await db.update(videoEntities)
    .set({ status: 'processing', metadata })
    .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));

  await addScreencastJob({
    projectId,
    videoId,
    url,
    durationLimit,
    endSelectors,
    playSelectors,
    skipPlayClick,
    idleValueSelector,
    idleSeconds,
    consoleEndPatterns,
  });
}

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/', async (request, reply) => {
    const list = await db.query.projects.findMany({
      where: eq(projects.ownerId, request.user!.id),
    });
    return reply.send(list);
  });

  fastify.post('/', async (request, reply) => {
    const schema = z.object({ name: z.string().min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(body.error);
    }
    const [project] = await db.insert(projects).values({
      name: body.data.name,
      ownerId: request.user!.id,
    }).returning();
    return reply.status(201).send(project);
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const [{ videoCount: videoCountVal }] = await db
      .select({ videoCount: count() })
      .from(videoEntities)
      .where(eq(videoEntities.projectId, id));
    const videoCount = Number(videoCountVal ?? 0);
    return reply.send({ ...project, videoCount });
  });

  /** List active workflow jobs for this project (for UI restore + busy indicators) */
  fastify.get('/:id/active-workflow-jobs', async (request, reply) => {
    const { id: projectId } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const jobs = listJobs().filter(
      (j) => j.projectId === projectId && j.videoId && j.status !== 'completed' && j.status !== 'failed'
    );
    return reply.send({
      jobs: jobs.map((j) => ({
        videoId: j.videoId,
        jobId: j.jobId,
        workflowId: j.workflowId,
      })),
    });
  });

  fastify.get('/:id/videos', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const videos = await db.query.videoEntities.findMany({
      where: eq(videoEntities.projectId, id),
    });
    const withUrls = await Promise.all(
      videos.map(async (v) => {
        const out = { ...v };
        if (v.sourceUrl?.startsWith('projects/')) {
          try {
            (out as Record<string, unknown>).playUrl = await getPresignedUrl(
              v.sourceUrl,
              3600
            );
            (out as Record<string, unknown>).streamUrl = `/api/projects/${id}/videos/${v.id}/stream`;
          } catch {
            // skip playUrl on error
          }
        }
        return out;
      })
    );
    return reply.send(withUrls);
  });

  /** Stream video from R2 with Range support (for seeking without full download) */
  fastify.get<{ Params: { id: string; videoId: string } }>('/:id/videos/:videoId/stream', async (request, reply) => {
    const { id, videoId } = request.params;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const sourceKey = video.sourceUrl;
    if (!sourceKey?.startsWith('projects/')) {
      return reply.status(400).send({ error: 'Video has no R2 source' });
    }

    const rangeHeader = request.headers.range;
    try {
      const { body, contentLength, contentType, contentRange, statusCode } = await streamObjectFromR2(
        sourceKey,
        rangeHeader
      );

      reply.status(statusCode);
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', String(contentLength));
      reply.header('Accept-Ranges', 'bytes');
      if (contentRange) reply.header('Content-Range', contentRange);

      return reply.send(body);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to stream video' });
    }
  });

  fastify.post('/:id/videos/upload', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'No file' });

    const ext = path.extname(data.filename) || '.mp4';
    const buffer = await data.toBuffer();

    const [video] = await db.insert(videoEntities).values({
      projectId: id,
      status: 'uploading',
      sourceUrl: null,
    }).returning();

    const key = `projects/${id}/${video.id}/video${ext}`;
    try {
      await uploadToR2(key, buffer);
      await db.update(videoEntities)
        .set({ status: 'ready', sourceUrl: key })
        .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
    } catch (err) {
      await db.update(videoEntities)
        .set({ status: 'failed', metadata: { error: String(err) } })
        .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
      return reply.status(500).send({ error: 'Upload failed' });
    }

    const [updated] = await db.select().from(videoEntities)
      .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
    const out = { ...(updated ?? video) };
    try {
      (out as Record<string, unknown>).playUrl = await getPresignedUrl(key, 3600);
    } catch {
      // ignore
    }

    return reply.status(201).send(out);
  });

  fastify.post('/:id/videos/url', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const schema = z.object({ url: z.string().url() });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid URL' });

    const provider = await resolveProviderForUrl(body.data.url);
    const [video] = await db.insert(videoEntities).values({
      projectId: id,
      status: 'processing',
      sourceUrl: body.data.url,
      metadata: provider ? { providerId: provider.id } : {},
    }).returning();

    const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);

    let endSelectors: string[] | undefined;
    let playSelectors: string[] | undefined;
    let skipPlayClick: boolean | undefined;
    let idleValueSelector: string | undefined;
    let idleSeconds: number | undefined;
    let consoleEndPatterns: string[] | undefined;

    if (provider) {
      playSelectors = (provider.playSelectors as string[])?.length ? (provider.playSelectors as string[]) : undefined;
      endSelectors = (provider.endSelectors as string[])?.length ? (provider.endSelectors as string[]) : undefined;
      idleValueSelector = provider.idleValueSelector ?? undefined;
      idleSeconds = provider.idleSeconds ?? 40;
      consoleEndPatterns = (provider.consoleEndPatterns as string[])?.length ? (provider.consoleEndPatterns as string[]) : undefined;
      skipPlayClick = (provider as { skipPlayClick?: boolean }).skipPlayClick;
    }

    if (!playSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_PLAY_SELECTORS;
        if (s) playSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!endSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_END_SELECTORS;
        if (s) endSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!idleValueSelector) {
      const s = process.env.SCREENCAST_IDLE_SELECTOR;
      if (s) idleValueSelector = s;
    }
    if (idleSeconds == null) {
      const s = process.env.SCREENCAST_IDLE_SECONDS;
      if (s) idleSeconds = parseInt(s, 10);
    }
    if (!consoleEndPatterns?.length) {
      try {
        const s = process.env.SCREENCAST_CONSOLE_END_PATTERNS;
        if (s) consoleEndPatterns = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }

    if (body.data.url.includes('bgaming-network.com') && !provider) {
      if (!playSelectors?.length) playSelectors = ['#playBtn', 'button#playBtn', '[class*="replay"]'];
      if (!idleValueSelector) idleValueSelector = '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]';
      if (idleSeconds == null) idleSeconds = 40;
    }
    if (body.data.url.includes('rowzones.com')) {
      if (!playSelectors?.length) playSelectors = []; // Animation starts immediately
      if (!endSelectors?.length) endSelectors = ['[class*="replay-summary"]', '[class*="ReplaySummary"]', '[class*="summary"]'];
      if (!consoleEndPatterns?.length) consoleEndPatterns = ['shell:modal:active'];
      skipPlayClick = true;
    }

    await addScreencastJob({
      projectId: id,
      videoId: video.id,
      url: body.data.url,
      durationLimit,
      endSelectors,
      playSelectors,
      skipPlayClick,
      idleValueSelector,
      idleSeconds,
      consoleEndPatterns,
    });

    return reply.status(201).send(video);
  });

  fastify.get('/:id/videos/:videoId/live-preview', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    const buffer = getFrame(videoId);
    if (!buffer) {
      return reply.status(204).send();
    }
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(buffer);
  });

  fastify.post('/:id/videos/:videoId/stop', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'processing') {
      return reply.status(400).send({ error: 'Video is not being recorded' });
    }

    const meta = (video.metadata as Record<string, unknown>) || {};
    await db.update(videoEntities)
      .set({ metadata: { ...meta, stopRequested: true } })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));

    request.log.info({ videoId: videoId.slice(0, 8) }, 'Stop requested, worker will pick up');
    return reply.send({ success: true });
  });

  fastify.post('/:id/videos/:videoId/restart', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'failed') {
      return reply.status(400).send({ error: 'Only failed recordings can be restarted' });
    }
    const url = video.sourceUrl;
    if (!url) {
      return reply.status(400).send({ error: 'No source URL to restart' });
    }

    await enqueueScreencastJobForUrl(id, videoId, url);
    return reply.send({ success: true });
  });

  /** Re-record: replace existing video with a new recording from the same source URL. Keeps project intact. */
  fastify.post('/:id/videos/:videoId/re-record', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status === 'processing') {
      return reply.status(400).send({ error: 'Video is already being recorded' });
    }

    const meta = (video.metadata as Record<string, unknown>) || {};
    const url = (meta.originalReplayUrl as string) || (video.sourceUrl?.startsWith('http') ? video.sourceUrl : null);
    if (!url) {
      return reply.status(400).send({ error: 'No source URL to re-record. This video was uploaded manually or recorded before re-record was supported.' });
    }

    await enqueueScreencastJobForUrl(id, videoId, url);
    return reply.send({ success: true });
  });

  fastify.post('/:id/videos/:videoId/cancel', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'processing') {
      return reply.status(400).send({ error: 'Video is not being recorded' });
    }

    await db.update(videoEntities)
      .set({ status: 'cancelled', metadata: { cancelledAt: new Date().toISOString() } })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    await removeScreencastJobByVideoId(videoId);
    clearFrame(videoId);
    return reply.send({ success: true });
  });

  fastify.patch('/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const schema = z.object({
      displayName: z.string().optional(),
      metadata: z.object({
        providerId: z.string().uuid().nullable().optional(),
        tagColor: z.string().nullable().optional(),
      }).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);

    const updates: Record<string, unknown> = {};
    if (body.data.displayName !== undefined) updates.displayName = body.data.displayName;
    if (body.data.metadata !== undefined) {
      const meta = (video.metadata as Record<string, unknown>) ?? {};
      if (body.data.metadata.providerId !== undefined) {
        meta.providerId = body.data.metadata.providerId;
      }
      if (body.data.metadata.tagColor !== undefined) {
        meta.tagColor = body.data.metadata.tagColor;
      }
      updates.metadata = meta;
    }
    if (Object.keys(updates).length === 0) return reply.send(video);

    const [updated] = await db.update(videoEntities)
      .set(updates as Record<string, string>)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)))
      .returning();
    return reply.send(updated ?? video);
  });

  fastify.get('/:id/videos/:videoId/logs', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const logs = getVideoLogs(videoId);
    return reply.send({ logs });
  });

  fastify.get('/:id/videos/:videoId/assets', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const prefix1 = `projects/${projectId}/${videoId}/`;
    const prefix2 = `projects/${projectId}/videos/${videoId}/`;
    const [list1, list2] = await Promise.all([
      listObjectsWithMetaFromR2(prefix1),
      listObjectsWithMetaFromR2(prefix2),
    ]);
    const all = [...list1, ...list2].filter((obj) => !obj.key.includes('/workflow-cache/'));
    const assets = await Promise.all(
      all.map(async (obj) => {
        let previewUrl: string | undefined;
        try {
          previewUrl = await getPresignedUrl(obj.key, 3600);
        } catch {
          // skip
        }
        const shortKey = obj.key.startsWith(prefix1)
          ? obj.key.slice(prefix1.length)
          : obj.key.startsWith(prefix2)
            ? obj.key.slice(prefix2.length)
            : obj.key;
        return {
          key: obj.key,
          shortKey,
          size: obj.size,
          lastModified: obj.lastModified?.toISOString(),
          contentType: obj.contentType,
          previewUrl,
        };
      })
    );
    return reply.send({ assets });
  });

  fastify.delete('/:id/videos/:videoId/assets', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({
      key: z.string().min(1).optional(),
      keys: z.array(z.string().min(1)).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const keys = body.data.keys ?? (body.data.key ? [body.data.key] : []);
    if (keys.length === 0) return reply.status(400).send({ error: 'key or keys required' });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const allowedPrefix1 = `projects/${projectId}/${videoId}/`;
    const allowedPrefix2 = `projects/${projectId}/videos/${videoId}/`;
    const validKeys = keys.filter(
      (k) => k.startsWith(allowedPrefix1) || k.startsWith(allowedPrefix2)
    );
    if (validKeys.length !== keys.length) {
      return reply.status(403).send({ error: 'One or more asset keys not allowed for this video' });
    }

    await deleteMultipleFromR2(validKeys);
    return reply.send({ success: true, deleted: validKeys.length });
  });

  fastify.post('/:id/videos/:videoId/workflow-cache/ensure', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({
      items: z.array(z.object({ moduleId: z.string(), moduleType: z.string() })).min(1),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    await ensureWorkflowModuleCacheDirs(projectId, videoId, body.data.items);
    return reply.send({ success: true });
  });

  /** Get variable values for a workflow on a specific video. POST with workflow body. */
  fastify.post<{
    Params: { id: string; videoId: string };
    Body: { workflow?: { modules?: Array<{ id: string; type: string; outputs?: Record<string, string>; params?: Record<string, unknown> }> } };
  }>('/:id/videos/:videoId/workflow-variables', async (request, reply) => {
    const { id: projectId, videoId } = request.params;
    const { workflow } = request.body ?? {};
    const modules = workflow?.modules ?? [];

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const values: Record<string, { value: string; preview?: string; url?: string }> = {};

    values.source = {
      value: video.sourceUrl ?? '(no source)',
      preview: video.sourceUrl?.startsWith('projects/') ? 'R2 object' : undefined,
      url: video.sourceUrl?.startsWith('projects/') ? `/api/projects/${projectId}/videos/${videoId}/stream` : undefined,
    };

    // Use central variable resolver (same as runner) — safe for variable renames
    const resolved = await resolveWorkflowVariablesForApi(projectId, videoId, { modules });
    for (const [varName, info] of Object.entries(resolved)) {
      const fileUrl = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(info.folderName)}/file?path=${encodeURIComponent(info.fileName)}`;
      values[varName] = {
        value: fileUrl,
        preview: info.isText ? '(text file)' : '(video file)',
        url: fileUrl,
      };
    }

    return reply.send({ variables: values });
  });

  /** Sync workflow step outputs from backend cache (source of truth). Use after page reload to fix stale cache. */
  fastify.post<{
    Params: { id: string; videoId: string };
    Body: { workflow?: { modules?: Array<{ id: string; type: string; outputs?: Record<string, string> }> } };
  }>('/:id/videos/:videoId/workflow-cache/state', async (request, reply) => {
    const { id: projectId, videoId } = request.params;
    const { workflow } = request.body ?? {};
    const modules = workflow?.modules ?? [];

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const cacheBase = process.env.WORKFLOW_CACHE_BASE || path.join(process.cwd(), 'workflow-cache');
    const videoDir = path.join(cacheBase, projectId, videoId);
    const folders = await listWorkflowModuleCache(projectId, videoId);

    const stepOutputUrls: Record<number, string> = {};
    const stepOutputContentTypes: Record<number, string> = {};
    const stepRemotionSceneUrls: Record<number, string> = {};
    const stepStatuses: Record<number, 'done' | 'pending'> = {};
    const slotsByModuleId: Record<string, Array<{ key: string; kind: string; label?: string }>> = {};

    for (let i = 0; i < modules.length; i++) {
      const def = modules[i];
      const mod = getModule(def.type);
      if (!mod || !def.outputs) continue;

      const match = folders.find((f) => f.moduleId === def.id);
      if (!match) continue;

      const dirPath = path.join(videoDir, match.folderName);
      const firstSlot = mod.meta.outputSlots?.[0];
      const kind = firstSlot?.kind === 'text' ? 'text' : firstSlot?.kind === 'file' ? 'file' : 'video';
      const outPath = await findOutputInCacheDir(dirPath, kind);
      if (!outPath) continue;

      const fileName = path.basename(outPath);
      const fileUrl = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(match.folderName)}/file?path=${encodeURIComponent(fileName)}`;
      stepOutputUrls[i] = fileUrl;
      stepStatuses[i] = 'done';
      const ext = fileName.toLowerCase();
      stepOutputContentTypes[i] = ext.endsWith('.md') ? 'text/markdown' : ext.endsWith('.json') ? 'application/json' : kind === 'text' ? 'text/plain' : 'video/mp4';
      if (def.type === 'video.render.remotion') {
        stepRemotionSceneUrls[i] = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(match.folderName)}/file?path=${encodeURIComponent('scene.json')}`;
      }
      if (def.type === 'llm.scenario.generator' && def.id) {
        const slotsResult = await readWorkflowModuleSlots(projectId, videoId, def.id);
        if (slotsResult?.slots?.length) {
          slotsByModuleId[def.id] = slotsResult.slots;
        }
      }
    }

    return reply.send({ stepOutputUrls, stepOutputContentTypes, stepRemotionSceneUrls, stepStatuses, slotsByModuleId });
  });

  fastify.post<{
    Params: { id: string; videoId: string };
    Body: { prompt: string; params?: Record<string, unknown>; contextText?: string };
  }>('/:id/videos/:videoId/generate-scenario', async (request, reply) => {
    const { id: projectId, videoId } = request.params;
    const body = request.body as { prompt?: string; params?: Record<string, unknown>; contextText?: string } | undefined;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const prompt = String(body?.prompt ?? '').trim();
    if (!prompt) return reply.status(400).send({ error: 'prompt is required' });

    const p = body?.params ?? {};
    const result = await generateScenarioPreview({
      prompt,
      contextText: typeof body?.contextText === 'string' ? body.contextText : undefined,
      apiKeyEnvVar: String(p.apiKeyEnvVar ?? 'OPENROUTER_API_KEY'),
      model: String(p.model ?? 'google/gemini-2.0-flash-001'),
      temperature: Number(p.temperature ?? 0.5),
      maxTokens: Number(p.maxTokens ?? 4096),
    });

    if (!result.success) return reply.status(400).send({ error: result.error });
    return reply.send({ json: result.json, slots: result.slots });
  });

  fastify.get<{
    Params: { id: string; videoId: string; moduleId: string };
  }>('/:id/videos/:videoId/workflow-cache/slots/:moduleId', async (request, reply) => {
    const { id: projectId, videoId, moduleId } = request.params;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const result = await readWorkflowModuleSlots(projectId, videoId, moduleId);
    if (!result) return reply.status(404).send({ error: 'Slots not found. Run the scenario generator first.' });
    return reply.send(result);
  });

  fastify.get('/:id/videos/:videoId/workflow-cache', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const folders = await listWorkflowModuleCache(projectId, videoId);
    return reply.send({ workflowCache: folders });
  });

  fastify.get('/:id/videos/:videoId/workflow-cache/metadata', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const folders = await listWorkflowModuleCache(projectId, videoId);
    const byModuleId: Record<string, { executionTimeMs?: number; costUsd?: number; tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string }> = {};
    let aggregatedCostUsd = 0;
    let aggregatedExecutionTimeMs = 0;
    const aggregatedTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    await ensurePricingLoaded();
    for (const { folderName, moduleId } of folders) {
      const meta = await readWorkflowModuleMetadata(projectId, videoId, folderName);
      if (meta) {
        let costUsd = meta.costUsd;
        if (costUsd == null && meta.tokenUsage && meta.model) {
          costUsd = calculateCost(
            meta.model,
            meta.tokenUsage.prompt_tokens ?? 0,
            meta.tokenUsage.completion_tokens ?? 0
          );
          if (costUsd > 0) costUsd = Math.round(costUsd * 10000) / 10000;
        }
        const entry = { ...meta, costUsd: costUsd ?? meta.costUsd };
        byModuleId[moduleId] = entry;
        if (typeof entry.costUsd === 'number' && entry.costUsd > 0) aggregatedCostUsd += entry.costUsd;
        if (typeof meta.executionTimeMs === 'number' && meta.executionTimeMs > 0) aggregatedExecutionTimeMs += meta.executionTimeMs;
        if (meta.tokenUsage) {
          aggregatedTokenUsage.prompt_tokens += meta.tokenUsage.prompt_tokens ?? 0;
          aggregatedTokenUsage.completion_tokens += meta.tokenUsage.completion_tokens ?? 0;
          aggregatedTokenUsage.total_tokens += meta.tokenUsage.total_tokens ?? (meta.tokenUsage.prompt_tokens ?? 0) + (meta.tokenUsage.completion_tokens ?? 0);
        }
      }
    }
    const lastRun = {
      totalCostUsd: aggregatedCostUsd > 0 ? aggregatedCostUsd : undefined,
      totalExecutionTimeMs: aggregatedExecutionTimeMs > 0 ? aggregatedExecutionTimeMs : undefined,
      totalTokenUsage: aggregatedTokenUsage.total_tokens > 0 ? aggregatedTokenUsage : undefined,
    };
    return reply.send({ metadata: byModuleId, lastRun });
  });

  fastify.get<{
    Params: { id: string; videoId: string; folderName: string };
    Querystring: { path?: string };
  }>('/:id/videos/:videoId/workflow-cache/:folderName/contents', async (request, reply) => {
    const { id: projectId, videoId, folderName } = request.params;
    const { path: subPath } = request.query;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    try {
      const entries = await listWorkflowCacheFolderContents(projectId, videoId, folderName, subPath);
      return reply.send({ entries });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Invalid') || msg.includes('ENOENT')) {
        return reply.status(400).send({ error: msg });
      }
      throw err;
    }
  });

  fastify.get<{
    Params: { id: string; videoId: string; folderName: string };
    Querystring: { path: string };
  }>('/:id/videos/:videoId/workflow-cache/:folderName/file', async (request, reply) => {
    const { id: projectId, videoId, folderName } = request.params;
    const { path: filePath } = request.query;
    if (!filePath || typeof filePath !== 'string') {
      return reply.status(400).send({ error: 'path query is required' });
    }
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    try {
      const { absolutePath, r2Key, contentType } = await getWorkflowCacheFilePath(projectId, videoId, folderName, filePath);
      
      const rangeHeader = request.headers.range;

      if (r2Key) {
        // Stream from R2
        const { body, contentLength, contentType: r2ContentType, contentRange, statusCode } = await streamObjectFromR2(
          r2Key,
          rangeHeader
        );

        reply.status(statusCode);
        reply.header('Content-Type', r2ContentType || contentType);
        reply.header('Content-Length', String(contentLength));
        reply.header('Accept-Ranges', 'bytes');
        if (contentRange) reply.header('Content-Range', contentRange);

        return reply.send(body);
      }

      if (!absolutePath) throw new Error('Not a file');

      const stat = fs.statSync(absolutePath);
      const fileSize = stat.size;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          return reply.status(416)
            .header('Content-Range', `bytes */${fileSize}`)
            .send({ error: 'Invalid Range header' });
        }
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        if (start >= fileSize || end >= fileSize || start > end) {
          return reply.status(416)
            .header('Content-Range', `bytes */${fileSize}`)
            .send({ error: 'Range not satisfiable' });
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(absolutePath, { start, end });
        return reply
          .status(206)
          .header('Content-Type', contentType)
          .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
          .header('Accept-Ranges', 'bytes')
          .header('Content-Length', String(chunkSize))
          .send(stream);
      }

      const stream = fs.createReadStream(absolutePath);
      return reply
        .header('Content-Type', contentType)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(fileSize))
        .send(stream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Invalid') || msg.includes('Not a file') || msg.includes('ENOENT')) {
        return reply.status(400).send({ error: msg });
      }
      throw err;
    }
  });

  fastify.post('/:id/videos/:videoId/workflow-cache/cleanup', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({ moduleIds: z.array(z.string()).min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    await cleanupWorkflowModuleCache(projectId, videoId, body.data.moduleIds);
    return reply.send({ success: true });
  });

  fastify.delete('/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    // If recording, signal worker to stop before deleting
    await db.update(videoEntities)
      .set({ status: 'cancelled' })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id), eq(videoEntities.status, 'processing')));

    const [deleted] = await db.delete(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)))
      .returning();

    if (!deleted) return reply.status(404).send({ error: 'Video not found' });

    try {
      const prefix = `projects/${id}/${videoId}/`;
      await deletePrefixFromR2(prefix);
      if (deleted.sourceUrl?.startsWith('projects/') && !deleted.sourceUrl.includes(`/${videoId}/`)) {
        await deleteFromR2(deleted.sourceUrl);
      }
    } catch (err) {
      request.log.warn({ err, videoId, projectId: id }, 'R2 delete failed');
    }

    return reply.send({ success: true });
  });

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      name: z.string().min(1).optional(),
      workflowId: z.string().nullable().optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);
    const updates: { name?: string; workflowId?: string | null; updatedAt: Date } = { updatedAt: new Date() };
    if (body.data.name !== undefined) updates.name = body.data.name;
    if (body.data.workflowId !== undefined) updates.workflowId = body.data.workflowId;
    const [updated] = await db.update(projects)
      .set(updates)
      .where(eq(projects.id, id))
      .returning();
    if (!updated || updated.ownerId !== request.user!.id) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.send(updated);
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deleted] = await db.delete(projects)
      .where(eq(projects.id, id))
      .returning();
    if (!deleted || deleted.ownerId !== request.user!.id) {
      return reply.status(404).send({ error: 'Not found' });
    }
    try {
      await deletePrefixFromR2(`projects/${id}/`);
    } catch (err) {
      request.log.warn({ err, projectId: id }, 'R2 project delete failed');
    }
    return reply.send({ success: true });
  });
};

export default projectsRoutes;
