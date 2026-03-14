import { Queue } from 'bullmq';

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

export const screencastQueue = new Queue('screencast', {
  connection: { ...redisOpts, maxRetriesPerRequest: null },
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const workflowQueue = new Queue('workflow', {
  connection: { ...redisOpts, maxRetriesPerRequest: null },
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export type ScreencastJobData = {
  projectId: string;
  videoId: string;
  url: string;
  durationLimit?: number;
  endSelectors?: string[];
  playSelectors?: string[];
  /** Selectors for mute/sound button to click and enable audio before recording (e.g. Rowzones). */
  unmuteSelectors?: string[];
  /** When true, skip play button click (e.g. Rowzones where animation starts immediately). */
  skipPlayClick?: boolean;
  /** Provider-specific: selector for element whose value we monitor (e.g. Total Win). If unchanged for idleSeconds, stop. */
  idleValueSelector?: string;
  /** Seconds of no change in idleValueSelector before auto-stop. Default 40. */
  idleSeconds?: number;
  /** Console log patterns that indicate replay ended (e.g. "track Spin Started" at end). */
  consoleEndPatterns?: string[];
};

export async function addScreencastJob(data: ScreencastJobData) {
  const job = await screencastQueue.add('record', data);
  console.log('[Queue] Added screencast job', job.id, 'videoId=', data.videoId?.slice(0, 8));
  return job;
}

export async function removeScreencastJobByVideoId(videoId: string): Promise<number> {
  const waiting = await screencastQueue.getWaiting();
  let removed = 0;
  for (const job of waiting) {
    if (job.data?.videoId === videoId) {
      await job.remove();
      removed++;
    }
  }
  return removed;
}

export type WorkflowJobData = {
  projectId: string;
  videoId: string;
  workflowId: string;
  workflow: { name: string; modules: unknown[] };
  /** If set, run only this step (0-based). Otherwise run full workflow. */
  stepIndex?: number;
  sourceVideoKey: string;
};

export async function addWorkflowJob(data: WorkflowJobData): Promise<{ id: string }> {
  const jobName = data.stepIndex != null ? 'step' : 'run';

  const [waiting, active] = await Promise.all([
    workflowQueue.getWaiting(),
    workflowQueue.getActive(),
  ]);
  const existing = [...waiting, ...active].find((j) => {
    const d = j.data as WorkflowJobData;
    if (d?.videoId !== data.videoId) return false;
    return data.stepIndex != null
      ? d.stepIndex === data.stepIndex
      : d.stepIndex == null;
  });
  if (existing) {
    console.log('[Queue] Workflow job already queued/running for this video, returning existing', existing.id);
    return { id: existing.id! };
  }

  const job = await workflowQueue.add(jobName, data);
  console.log('[Queue] Added workflow job', job.id, 'workflowId=', data.workflowId, 'stepIndex=', data.stepIndex);
  return { id: job.id! };
}

/** Check if Redis is reachable. Used at startup and for health endpoint. */
export async function checkRedisConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    await workflowQueue.getJobCounts();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

