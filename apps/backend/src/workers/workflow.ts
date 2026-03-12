import fs from 'fs/promises';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import { runWorkflow } from '../lib/workflow/runner.js';
import { uploadToR2, getPresignedUrl } from '../lib/r2.js';
import {
  createJob,
  updateJob,
  appendJobLog,
  appendAgentReasoning,
  isCancelRequested,
  clearCancelRequest,
} from '../lib/workflow-job-store.js';
import { appendVideoLog } from '../lib/video-logs-store.js';
import type { WorkflowJobData } from '../lib/queue.js';
import type { WorkflowDefinition } from '../lib/workflow/types.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const redisOpts = parseRedisUrl(REDIS_URL);

async function processWorkflowJob(job: Job<WorkflowJobData>) {
  const { projectId, videoId, workflowId, workflow, stepIndex, sourceVideoKey } = job.data;
  const jobId = job.id!;

  const { state } = createJob({
    jobId,
    status: 'active',
    projectId,
    videoId,
    workflowId,
    workflowName: workflow.name,
    stepIndex,
  });

  const abortController = new AbortController();
  const cancelCheckInterval = setInterval(() => {
    if (isCancelRequested(jobId)) {
      abortController.abort();
      clearInterval(cancelCheckInterval);
    }
  }, 1000);

  try {
    const result = await runWorkflow({
      projectId,
      videoId,
      sourceVideoKey,
      workflow: workflow as WorkflowDefinition,
      stepIndex,
      onProgress: (pct, msg) => {
        state.progress = pct;
        state.message = msg;
      },
      onStepStart: (idx) => {
        state.stepIndex = idx;
      },
      onLog: (msg) => {
        appendJobLog(jobId, msg);
        appendVideoLog(videoId, msg);
      },
      onAgentReasoning: (content) => appendAgentReasoning(jobId, content),
      onCheckCancel: () => isCancelRequested(jobId),
      signal: abortController.signal,
    });

    clearInterval(cancelCheckInterval);
    clearCancelRequest(jobId);

    if (!result.success) {
      updateJob(jobId, {
        status: 'failed',
        error: result.error,
        stepResults: result.stepResults,
      });
      throw new Error(result.error);
    }

    const lastStep = result.lastStepOutput;
    if (lastStep?.kind === 'text') {
      const pathEnc = encodeURIComponent(lastStep.relativePath);
      const folderEnc = encodeURIComponent(lastStep.cacheFolderName);
      const outputUrl = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${folderEnc}/file?path=${pathEnc}`;
      const ext = lastStep.relativePath.toLowerCase();
      const outputContentType = ext.endsWith('.md') ? 'text/markdown' : ext.endsWith('.json') ? 'application/json' : 'text/plain';
      updateJob(jobId, { outputUrl, outputContentType });
    } else if (result.context?.currentVideoPath) {
      try {
        const buf = await fs.readFile(result.context.currentVideoPath);
        const suffix = stepIndex != null ? `step-${stepIndex}.mp4` : 'full.mp4';
        const key = `projects/${projectId}/videos/${videoId}/workflow-output/${suffix}`;
        await uploadToR2(key, buf, 'video/mp4');
        const outputUrl = await getPresignedUrl(key, 3600);
        const jobUpdates: { outputUrl: string; remotionSceneUrl?: string } = { outputUrl };

        const cacheDir = path.dirname(result.context.currentVideoPath);
        try {
          await fs.writeFile(path.join(cacheDir, 'r2-uploaded-key.txt'), key, 'utf8');
        } catch {
          /* non-fatal: listing will fall back to workflow-cache URL */
        }

        const idx = stepIndex ?? (workflow.modules?.length ?? 1) - 1;
        const lastMod = workflow.modules?.[idx] as Record<string, unknown> | undefined;
        if (lastMod?.type === 'video.render.remotion') {
          const folderName = path.basename(cacheDir);
          const remotionSceneUrl = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folderName)}/file?path=${encodeURIComponent('scene.json')}`;
          jobUpdates.remotionSceneUrl = remotionSceneUrl;
        }
        updateJob(jobId, jobUpdates);
      } catch (e) {
        const msg = `Upload failed: ${e}`;
        appendJobLog(jobId, msg);
        appendVideoLog(videoId, msg);
      }
    }

    updateJob(jobId, {
      status: 'completed',
      progress: 100,
      stepResults: result.stepResults,
      totalTokenUsage: result.totalTokenUsage,
      totalCostUsd: result.totalCostUsd,
      totalExecutionTimeMs: result.totalExecutionTimeMs,
    });

    const hasCost = typeof result.totalCostUsd === 'number' && result.totalCostUsd > 0;
    const hasTime = typeof result.totalExecutionTimeMs === 'number' && result.totalExecutionTimeMs > 0;
    const hasTokens = result.totalTokenUsage && result.totalTokenUsage.total_tokens > 0;
    if (hasCost || hasTime || hasTokens) {
      try {
        const [video] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
        if (video) {
          const meta = (video.metadata as Record<string, unknown>) || {};
          await db.update(videoEntities)
            .set({
              metadata: {
                ...meta,
                workflowLastRun: {
                  totalTokenUsage: hasTokens ? result.totalTokenUsage : undefined,
                  totalCostUsd: hasCost ? result.totalCostUsd : undefined,
                  totalExecutionTimeMs: hasTime ? result.totalExecutionTimeMs : undefined,
                },
              },
            })
            .where(eq(videoEntities.id, videoId));
        }
      } catch (e) {
        console.error('[WorkflowWorker] Failed to save last run to video metadata:', e);
      }
    }
  } catch (err) {
    clearInterval(cancelCheckInterval);
    clearCancelRequest(jobId);
    const error = err instanceof Error ? err.message : String(err);
    if (!state.error) {
      updateJob(jobId, { status: 'failed', error });
    }
    throw err;
  }
}

export function startWorkflowWorker(): Worker<WorkflowJobData> {
  const worker = new Worker<WorkflowJobData>(
    'workflow',
    processWorkflowJob,
    {
      connection: { ...redisOpts, maxRetriesPerRequest: null },
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    console.log('[WorkflowWorker] Job completed', job.id);
  });

  worker.on('failed', (job, err) => {
    console.error('[WorkflowWorker] Job failed', job?.id, err.message);
  });

  worker.on('error', (err) => {
    console.error('[WorkflowWorker] Worker error', err);
  });

  console.log('[WorkflowWorker] Started');
  return worker;
}
