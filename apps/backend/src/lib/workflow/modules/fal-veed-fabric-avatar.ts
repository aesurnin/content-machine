import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { fal } from '@fal-ai/client';
import { db } from '../../../db/index.js';
import { contentLibraryItems } from '../../../db/schema/index.js';
import { getPresignedUrl, uploadToR2, deleteFromR2 } from '../../r2.js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

// ── Provider config ─────────────────────────────────────────────────────────

const FAL_MODEL_IDS: Record<string, string> = {
  'veed-fabric': 'veed/fabric-1.0',
  'kling-standard': 'fal-ai/kling-video/ai-avatar/v2/standard',
  'kling-pro': 'fal-ai/kling-video/ai-avatar/v2/pro',
};

/** USD per second of output video, keyed by provider -> resolution */
const PRICING: Record<string, Record<string, number>> = {
  'veed-fabric': { '480p': 0.08, '720p': 0.15 },
  'kling-standard': { default: 0.0562 },
  'kling-pro': { default: 0.115 },
  'runpod-pvideo': {
    '720p': 0.02, '1080p': 0.04,
    '720p-draft': 0.005, '1080p-draft': 0.01,
  },
};

const RUNPOD_PVIDEO_BASE = 'https://api.runpod.ai/v2/p-video';
const PVIDEO_MAX_DURATION_SEC = 10;
const PVIDEO_POLL_INTERVAL_MS = 3_000;
const PVIDEO_POLL_TIMEOUT_MS = 600_000;

// ── Module meta ─────────────────────────────────────────────────────────────

export const falVeedFabricAvatarMeta = {
  type: 'video.fal.veed-fabric',
  label: 'AI Avatar Video',
  description:
    'Generate talking avatar video from image + audio. ' +
    'Providers: fal.ai VEED Fabric, fal.ai Kling v2 Standard/Pro, RunPod P-Video.',
  category: 'Video',
  quickParams: ['provider', 'imageId', 'resolution'],
  inputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  outputSlots: [
    { key: 'video', label: 'Video', kind: 'video' as const },
  ],
  paramsSchema: [
    {
      key: 'provider', label: 'Provider', type: 'string' as const, default: 'veed-fabric',
      options: [
        { value: 'veed-fabric', label: 'fal.ai VEED Fabric 1.0' },
        { value: 'kling-standard', label: 'fal.ai Kling v2 Standard' },
        { value: 'kling-pro', label: 'fal.ai Kling v2 Pro' },
        { value: 'runpod-pvideo', label: 'RunPod P-Video' },
      ],
    },
    {
      key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'FAL_KEY',
      defaultByProvider: {
        'veed-fabric': 'FAL_KEY',
        'kling-standard': 'FAL_KEY',
        'kling-pro': 'FAL_KEY',
        'runpod-pvideo': 'RUNPOD_API_KEY',
      },
    },
    { key: 'imageId', label: 'Avatar image', type: 'string' as const, default: '' },
    {
      key: 'resolution', label: 'Resolution', type: 'string' as const, default: '720p',
      optionsByProvider: {
        'veed-fabric': [
          { value: '480p', label: '480p ($0.08/s)' },
          { value: '720p', label: '720p ($0.15/s)' },
        ],
        'kling-standard': [
          { value: '720p', label: '720p ($0.0562/s)' },
        ],
        'kling-pro': [
          { value: '720p', label: '720p ($0.115/s)' },
          { value: '1080p', label: '1080p ($0.115/s)' },
        ],
        'runpod-pvideo': [
          { value: '720p', label: '720p ($0.02/s)' },
          { value: '1080p', label: '1080p ($0.04/s)' },
        ],
      },
    },
    { key: 'klingPrompt', label: 'Kling prompt (optional)', type: 'string' as const, default: '.', providerOneOf: ['kling-standard', 'kling-pro'] },
    { key: 'pvideoPrompt', label: 'P-Video prompt', type: 'string' as const, default: '', provider: 'runpod-pvideo' },
    { key: 'pvideoDraft', label: 'P-Video draft mode (faster, cheaper)', type: 'boolean' as const, default: false, provider: 'runpod-pvideo' },
  ],
};

// ── Shared helpers ──────────────────────────────────────────────────────────

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

async function uploadAudioToFal(apiKey: string, filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = AUDIO_MIME[ext] ?? 'audio/mpeg';
  const blob = new Blob([buffer], { type: contentType });
  fal.config({ credentials: apiKey });
  return await fal.storage.upload(blob);
}

async function downloadVideo(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getMediaDurationSec(filePath: string): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d));
    proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`ffprobe exit ${code}`))));
    proc.on('error', reject);
  });
  return parseFloat(output) || 0;
}

// ── fal.ai generation (VEED Fabric + Kling v2) ─────────────────────────────

async function runFalGeneration(
  apiKey: string,
  provider: string,
  imageUrl: string,
  audioUrl: string,
  resolution: string,
  prompt?: string,
  onProgress?: (percent: number, message: string) => void,
): Promise<{ videoUrl: string; durationFromApi?: number }> {
  const modelId = FAL_MODEL_IDS[provider];
  if (!modelId) throw new Error(`Unknown fal.ai provider: ${provider}`);

  fal.config({ credentials: apiKey });

  const input: Record<string, unknown> = { image_url: imageUrl, audio_url: audioUrl };
  if (provider === 'veed-fabric') {
    input.resolution = resolution as '720p' | '480p';
  }
  if (provider === 'kling-standard' || provider === 'kling-pro') {
    input.prompt = (prompt ?? '.').trim() || '.';
  }

  const result = await fal.subscribe(modelId, {
    input,
    logs: true,
    onQueueUpdate: (update) => {
      const u = update as { status?: string; logs?: Array<{ message?: string }> };
      const msg =
        u.status === 'IN_QUEUE'
          ? 'In queue'
          : u.status === 'IN_PROGRESS'
            ? (u.logs?.[u.logs.length - 1]?.message ?? 'Processing')
            : String(u.status ?? '');
      onProgress?.(u.status === 'IN_QUEUE' ? 10 : 50, `fal.ai: ${msg}`);
    },
  });

  const data = (result as { data?: Record<string, unknown> }).data;
  const videoUrl = (data?.video as { url?: string } | undefined)?.url;
  if (!videoUrl) {
    throw new Error(`fal.ai did not return video URL. Keys: ${JSON.stringify(Object.keys(data ?? {}))}`);
  }
  const durationFromApi = typeof data?.duration === 'number' ? data.duration : undefined;
  return { videoUrl, durationFromApi };
}

// ── RunPod P-Video helpers ──────────────────────────────────────────────────

async function splitAudioIntoChunks(
  audioPath: string,
  maxSec: number,
  totalDuration: number,
  outDir: string,
): Promise<string[]> {
  const numChunks = Math.ceil(totalDuration / maxSec);
  const chunks: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * maxSec;
    const chunkPath = path.join(outDir, `chunk_${i}.mp3`);
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', [
        '-y', '-i', audioPath,
        '-ss', String(startSec), '-t', String(maxSec),
        '-acodec', 'libmp3lame', '-q:a', '2',
        chunkPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
    if (!ok) throw new Error(`Failed to split audio chunk ${i} at ${startSec}s`);
    chunks.push(chunkPath);
  }
  return chunks;
}

interface PVideoJobResult { videoUrl: string; cost: number }

async function submitPVideoJob(
  apiKey: string,
  input: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${RUNPOD_PVIDEO_BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input }),
  });
  const json = (await res.json()) as { id?: string; error?: string; status?: string };
  if (!res.ok || !json.id) {
    throw new Error(json.error ?? `RunPod submit failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.id;
}

async function pollPVideoJob(
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<PVideoJobResult> {
  const start = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error('Aborted');
    if (Date.now() - start > PVIDEO_POLL_TIMEOUT_MS) throw new Error('RunPod P-Video timed out (10 min)');

    const res = await fetch(`${RUNPOD_PVIDEO_BASE}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = (await res.json()) as Record<string, unknown>;
    const status = json.status as string | undefined;
    const output = json.output as Record<string, unknown> | string | undefined;
    const error = json.error as string | undefined;

    if (status === 'COMPLETED') {
      let videoUrl: string | undefined;
      let cost = 0;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        videoUrl = (output.result ?? output.video_url ?? output.video ?? output.output ?? output.url) as string | undefined;
        cost = (output.cost as number) ?? 0;
      } else if (Array.isArray(output) && output.length > 0) {
        const first = output[0] as Record<string, unknown> | string;
        videoUrl = typeof first === 'string' ? first : (first?.video_url ?? first?.video ?? first?.url) as string | undefined;
        const costObj = output.find((x) => x && typeof x === 'object' && 'cost' in x) as { cost?: number } | undefined;
        cost = costObj?.cost ?? 0;
      } else if (typeof output === 'string') {
        videoUrl = output;
      }
      if (!videoUrl || typeof videoUrl !== 'string') {
        throw new Error(`RunPod completed but no video URL in output. Keys: ${output && typeof output === 'object' && !Array.isArray(output) ? JSON.stringify(Object.keys(output)) : Array.isArray(output) ? `array[${output.length}]` : 'output not object'}. Raw: ${JSON.stringify(json).slice(0, 600)}`);
      }
      return { videoUrl, cost };
    }
    if (status === 'FAILED') {
      throw new Error((typeof error === 'string' ? error : undefined) ?? 'RunPod P-Video generation failed');
    }

    await new Promise((r) => setTimeout(r, PVIDEO_POLL_INTERVAL_MS));
  }
}

async function concatenateVideos(videoPaths: string[], outputPath: string): Promise<void> {
  const listFile = outputPath + '.concat.txt';
  await fs.writeFile(listFile, videoPaths.map((p) => `file '${p}'`).join('\n'), 'utf8');

  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 300_000);
  });

  await fs.unlink(listFile).catch(() => {});
  if (!ok) throw new Error('ffmpeg concat failed');
}

// ── Module class ────────────────────────────────────────────────────────────

export class FalVeedFabricAvatarModule implements WorkflowModule {
  readonly meta = falVeedFabricAvatarMeta;

  async run(ctx: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = ctx;
    const TAG = '[AI Avatar]';

    const provider = String(params.provider ?? 'veed-fabric');
    const defaultKey = provider === 'runpod-pvideo' ? 'RUNPOD_API_KEY' : 'FAL_KEY';
    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? defaultKey);
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey?.trim()) {
      onLog?.(`${TAG} ERROR: API key not set. Set env var: ${apiKeyEnvVar}`);
      return { success: false, error: `API key not set. Set environment variable: ${apiKeyEnvVar}` };
    }

    const imageId = String(params.imageId ?? '').trim();
    if (!imageId) {
      onLog?.(`${TAG} ERROR: No avatar image selected.`);
      return { success: false, error: 'No avatar image selected. Choose an image from the library.' };
    }

    const inputPaths = ctx.inputPaths ?? {};
    const audioPath = inputPaths['audio'] ?? ctx.currentAudioPath;
    if (!audioPath) {
      onLog?.(`${TAG} ERROR: No audio input.`);
      return { success: false, error: 'No audio input. Connect an audio source.' };
    }
    try { await fs.access(audioPath); } catch {
      onLog?.(`${TAG} ERROR: Audio file not found: ${audioPath}`);
      return { success: false, error: `Audio file not found: ${audioPath}` };
    }

    const resolution = String(params.resolution ?? '720p');

    onLog?.(`${TAG} === Module start ===`);
    onLog?.(`${TAG} Provider: ${provider}, Resolution: ${resolution}, Image: ${imageId}`);

    onProgress?.(0, 'Loading avatar image');
    const [imageItem] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, imageId), eq(contentLibraryItems.type, 'image')),
    );
    if (!imageItem) {
      onLog?.(`${TAG} ERROR: Image not found in library: ${imageId}`);
      return { success: false, error: `Image not found in library: ${imageId}` };
    }

    let imageUrl: string;
    try {
      imageUrl = await getPresignedUrl(imageItem.r2Key, 3600);
    } catch (err) {
      onLog?.(`${TAG} ERROR: Failed to get presigned URL: ${err}`);
      return { success: false, error: 'Failed to access avatar image from storage' };
    }

    const outDir = ctx.moduleCacheDir ?? ctx.tempDir;

    if (provider === 'runpod-pvideo') {
      return this.runPVideo(ctx, params, apiKey, imageUrl, audioPath, resolution, outDir);
    }
    return this.runFalProvider(ctx, params, provider, apiKey, imageUrl, audioPath, resolution, outDir);
  }

  // ── fal.ai providers (VEED Fabric, Kling Standard, Kling Pro) ───────────

  private async runFalProvider(
    ctx: WorkflowContext,
    params: Record<string, unknown>,
    provider: string,
    apiKey: string,
    imageUrl: string,
    audioPath: string,
    resolution: string,
    outDir: string,
  ): Promise<ModuleRunResult> {
    const { onProgress, onLog } = ctx;
    const TAG = '[AI Avatar]';
    const modelId = FAL_MODEL_IDS[provider]!;

    onProgress?.(5, 'Uploading audio to fal.ai');
    onLog?.(`${TAG} Uploading audio...`);

    let audioUrl: string;
    try {
      audioUrl = await uploadAudioToFal(apiKey, audioPath);
    } catch (err) {
      onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
      return { success: false, error: `fal.ai audio upload failed: ${(err as Error).message}` };
    }
    onLog?.(`${TAG} Audio URL: ${audioUrl.slice(0, 60)}...`);

    onProgress?.(15, 'Generating video');
    onLog?.(`${TAG} Calling ${modelId} (queue mode)...`);

    let genResult: { videoUrl: string; durationFromApi?: number };
    try {
      const klingPrompt = provider === 'kling-standard' || provider === 'kling-pro' ? String(params.klingPrompt ?? '.') : undefined;
      genResult = await runFalGeneration(apiKey, provider, imageUrl, audioUrl, resolution, klingPrompt, (pct, msg) => {
        onProgress?.(15 + (pct / 100) * 65, msg);
        onLog?.(`${TAG} ${msg}`);
      });
    } catch (err) {
      onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
      return { success: false, error: `fal.ai generation failed: ${(err as Error).message}` };
    }

    onProgress?.(85, 'Downloading video');
    onLog?.(`${TAG} Downloading result...`);

    let videoBuffer: Buffer;
    try {
      videoBuffer = await downloadVideo(genResult.videoUrl);
    } catch (err) {
      onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
      return { success: false, error: `Failed to download video: ${(err as Error).message}` };
    }

    const outputPath = path.join(outDir, 'output.mp4');
    await fs.writeFile(outputPath, videoBuffer);

    let durationSeconds = genResult.durationFromApi ?? 0;
    if (!durationSeconds) {
      try { durationSeconds = await getMediaDurationSec(outputPath); } catch {
        onLog?.(`${TAG} WARN: Could not determine video duration with ffprobe`);
      }
    }

    const pricingTable = PRICING[provider] ?? {};
    const costPerSec = pricingTable[resolution] ?? pricingTable['default'] ?? 0;
    const costUsd = Math.round(durationSeconds * costPerSec * 10000) / 10000;

    const stat = await fs.stat(outputPath);
    onLog?.(`${TAG} Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB, ${durationSeconds.toFixed(1)}s)`);
    if (costUsd > 0) {
      onLog?.(`${TAG} Cost: $${costUsd.toFixed(4)} (${durationSeconds.toFixed(1)}s × $${costPerSec}/s)`);
    }

    await fs.writeFile(
      path.join(outDir, 'metadata.json'),
      JSON.stringify({ provider: 'fal.ai', model: modelId, resolution, durationSeconds, costUsd }, null, 2),
      'utf8',
    );

    onProgress?.(100, 'Done');
    onLog?.(`${TAG} === Module complete ===`);

    return { success: true, context: { currentVideoPath: outputPath } };
  }

  // ── RunPod P-Video (with chunking for audio > 10s) ──────────────────────

  private async runPVideo(
    ctx: WorkflowContext,
    params: Record<string, unknown>,
    apiKey: string,
    imageUrl: string,
    audioPath: string,
    resolution: string,
    outDir: string,
  ): Promise<ModuleRunResult> {
    const { onProgress, onLog } = ctx;
    const TAG = '[AI Avatar]';
    const draft = Boolean(params.pvideoDraft ?? false);
    const prompt = String(params.pvideoPrompt ?? '').trim() || 'A person talking naturally to the camera';

    // ── Audio duration ────────────────────────────────────────────────
    onProgress?.(2, 'Analyzing audio');
    let audioDuration: number;
    try {
      audioDuration = await getMediaDurationSec(audioPath);
    } catch (err) {
      onLog?.(`${TAG} ERROR: Could not determine audio duration: ${err}`);
      return { success: false, error: 'Could not determine audio duration with ffprobe.' };
    }
    if (audioDuration <= 0) {
      return { success: false, error: 'Audio file appears empty or unreadable.' };
    }
    onLog?.(`${TAG} Audio duration: ${audioDuration.toFixed(1)}s`);

    const numChunks = Math.ceil(audioDuration / PVIDEO_MAX_DURATION_SEC);
    onLog?.(`${TAG} P-Video max ${PVIDEO_MAX_DURATION_SEC}s per generation => ${numChunks} chunk(s)`);

    // ── Split audio into chunks ───────────────────────────────────────
    onProgress?.(5, `Splitting audio into ${numChunks} chunks`);
    let audioChunks: string[];
    if (numChunks === 1) {
      audioChunks = [audioPath];
    } else {
      try {
        audioChunks = await splitAudioIntoChunks(audioPath, PVIDEO_MAX_DURATION_SEC, audioDuration, outDir);
      } catch (err) {
        onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
        return { success: false, error: `Audio splitting failed: ${(err as Error).message}` };
      }
    }
    onLog?.(`${TAG} Audio chunks ready: ${audioChunks.length}`);

    // ── Upload audio chunks to R2 for public URLs ─────────────────────
    onProgress?.(10, 'Uploading audio chunks');
    const batchId = randomUUID().slice(0, 8);
    const tempR2Keys: string[] = [];
    const audioUrls: string[] = [];

    try {
      for (let i = 0; i < audioChunks.length; i++) {
        const buffer = await fs.readFile(audioChunks[i]);
        const r2Key = `tmp/avatar-chunks/${batchId}/chunk_${i}.mp3`;
        await uploadToR2(r2Key, buffer, 'audio/mpeg');
        audioUrls.push(await getPresignedUrl(r2Key, 3600));
        tempR2Keys.push(r2Key);
        onLog?.(`${TAG} Uploaded audio chunk ${i + 1}/${audioChunks.length} to R2`);
      }
    } catch (err) {
      onLog?.(`${TAG} ERROR: R2 upload failed: ${(err as Error).message}`);
      await cleanupR2Keys(tempR2Keys);
      return { success: false, error: `Failed to upload audio chunks: ${(err as Error).message}` };
    }

    // ── Submit all P-Video jobs in parallel ────────────────────────────
    onProgress?.(15, 'Submitting generation jobs');
    const jobIds: string[] = [];

    try {
      const submissions = audioUrls.map(async (audioUrl, i) => {
        const remaining = audioDuration - i * PVIDEO_MAX_DURATION_SEC;
        const chunkDur = Math.max(1, Math.min(PVIDEO_MAX_DURATION_SEC, Math.ceil(remaining)));
        const jobId = await submitPVideoJob(apiKey, {
          prompt,
          image: imageUrl,
          audio: audioUrl,
          duration: chunkDur,
          size: resolution,
          fps: 24,
          aspect_ratio: '16:9',
          draft,
          prompt_upsampling: false,
          enable_safety_checker: true,
        });
        onLog?.(`${TAG} Job ${i + 1}/${numChunks} submitted: ${jobId} (${chunkDur}s)`);
        return jobId;
      });
      jobIds.push(...(await Promise.all(submissions)));
    } catch (err) {
      onLog?.(`${TAG} ERROR: Job submission failed: ${(err as Error).message}`);
      await cleanupR2Keys(tempR2Keys);
      return { success: false, error: `RunPod job submission failed: ${(err as Error).message}` };
    }

    // ── Poll all jobs until completion ─────────────────────────────────
    onLog?.(`${TAG} Polling ${jobIds.length} jobs...`);
    let totalCost = 0;
    const videoUrls: (string | undefined)[] = new Array(jobIds.length).fill(undefined);

    try {
      const polls = jobIds.map(async (jobId, i) => {
        const result = await pollPVideoJob(apiKey, jobId, ctx.signal);
        videoUrls[i] = result.videoUrl;
        totalCost += result.cost;
        const done = videoUrls.filter((v) => v != null).length;
        onProgress?.(15 + Math.round((done / jobIds.length) * 55), `Generated ${done}/${jobIds.length} chunks`);
        onLog?.(`${TAG} Job ${i + 1} completed (cost: $${result.cost.toFixed(4)})`);
      });
      await Promise.all(polls);
    } catch (err) {
      onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
      await cleanupR2Keys(tempR2Keys);
      return { success: false, error: `P-Video generation failed: ${(err as Error).message}` };
    }

    // ── Download all video chunks ─────────────────────────────────────
    onProgress?.(75, 'Downloading video chunks');
    const videoPaths: string[] = [];

    try {
      for (let i = 0; i < videoUrls.length; i++) {
        const buf = await downloadVideo(videoUrls[i]!);
        const vPath = path.join(outDir, `pvideo_chunk_${i}.mp4`);
        await fs.writeFile(vPath, buf);
        videoPaths.push(vPath);
        onLog?.(`${TAG} Downloaded chunk ${i + 1}/${videoUrls.length} (${(buf.length / 1024).toFixed(0)} KB)`);
      }
    } catch (err) {
      onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
      await cleanupR2Keys(tempR2Keys);
      return { success: false, error: `Video download failed: ${(err as Error).message}` };
    }

    // ── Concatenate chunks ────────────────────────────────────────────
    const outputPath = path.join(outDir, 'output.mp4');

    if (videoPaths.length === 1) {
      await fs.rename(videoPaths[0], outputPath);
    } else {
      onProgress?.(88, 'Concatenating video chunks');
      onLog?.(`${TAG} Concatenating ${videoPaths.length} chunks...`);
      try {
        await concatenateVideos(videoPaths, outputPath);
      } catch (err) {
        onLog?.(`${TAG} ERROR: ${(err as Error).message}`);
        await cleanupR2Keys(tempR2Keys);
        return { success: false, error: `Video concatenation failed: ${(err as Error).message}` };
      }
    }

    // ── Cleanup temp files ────────────────────────────────────────────
    await cleanupR2Keys(tempR2Keys);
    for (const p of videoPaths) await fs.unlink(p).catch(() => {});
    if (numChunks > 1) {
      for (const c of audioChunks) await fs.unlink(c).catch(() => {});
    }

    let durationSeconds = 0;
    try { durationSeconds = await getMediaDurationSec(outputPath); } catch { /* ignore */ }

    const stat = await fs.stat(outputPath);
    onLog?.(`${TAG} Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB, ${durationSeconds.toFixed(1)}s)`);
    onLog?.(`${TAG} Total cost: $${totalCost.toFixed(4)} (${numChunks} chunk(s))`);

    await fs.writeFile(
      path.join(outDir, 'metadata.json'),
      JSON.stringify({
        provider: 'runpod', model: 'p-video', resolution, draft, numChunks, durationSeconds, costUsd: totalCost,
      }, null, 2),
      'utf8',
    );

    onProgress?.(100, 'Done');
    onLog?.(`${TAG} === Module complete ===`);

    return { success: true, context: { currentVideoPath: outputPath } };
  }
}

async function cleanupR2Keys(keys: string[]): Promise<void> {
  for (const k of keys) await deleteFromR2(k).catch(() => {});
}
