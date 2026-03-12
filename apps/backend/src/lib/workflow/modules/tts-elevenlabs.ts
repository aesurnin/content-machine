import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';
import { getVideoDuration } from './utils.js';

/** Segment from the input JSON (comments with timing) */
interface CommentSegment {
  time: string;
  text: string;
  duration?: number;
  comment_for_ai_assistent?: string;
}

const ELEVENLABS_MODELS = [
  { value: 'eleven_v3', label: 'Eleven v3 (70+ languages, most expressive)' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 (29 languages)' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (fast, cheaper)' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (balanced)' },
] as const;

const OUTPUT_FORMATS = [
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
  { value: 'mp3_44100_64', label: 'MP3 44.1kHz 64kbps' },
  { value: 'mp3_22050_32', label: 'MP3 22kHz 32kbps' },
  { value: 'wav_44100', label: 'WAV 44.1kHz' },
] as const;

/** Parse "MM:SS" or "HH:MM:SS" to seconds */
function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

/** Write ReadableStream to file */
async function streamToFile(stream: ReadableStream<Uint8Array>, filePath: string): Promise<void> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  await fs.writeFile(filePath, buffer);
}

export const ttsElevenlabsMeta = {
  type: 'tts.elevenlabs',
  label: 'TTS ElevenLabs',
  description: 'Convert text segments to speech using ElevenLabs API and merge into a single audio track with timing',
  category: 'Audio',
  quickParams: ['voiceId', 'apiKeyEnvVar'],
  inputSlots: [
    { key: 'text', label: 'Comments JSON', kind: 'text' as const },
  ],
  outputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  paramsSchema: [
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'ELEVENLABS_API_KEY' },
    { key: 'voiceId', label: 'Voice ID', type: 'string' as const, default: '21m00Tcm4TlvDq8ikWAM' },
    { key: 'modelId', label: 'Model', type: 'string' as const, default: 'eleven_v3',
      options: ELEVENLABS_MODELS.map((o) => ({ value: o.value, label: o.label })) },
    { key: 'outputFormat', label: 'Output format', type: 'string' as const, default: 'mp3_44100_128',
      options: OUTPUT_FORMATS.map((o) => ({ value: o.value, label: o.label })) },
    { key: 'stability', label: 'Stability', type: 'number' as const, default: 0.5, min: 0, max: 1 },
    { key: 'similarityBoost', label: 'Similarity boost', type: 'number' as const, default: 0.75, min: 0, max: 1 },
    { key: 'trimOverlap', label: 'Trim overlap', type: 'boolean' as const, default: true },
  ],
};

export class TtsElevenlabsModule implements WorkflowModule {
  readonly meta = ttsElevenlabsMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;

    const inputPaths = context.inputPaths ?? {};
    const textPath = inputPaths['text'] ?? context.currentTextOutputPath;

    if (!textPath) {
      onLog?.('[TTS ElevenLabs] ERROR: No input provided. Connect a comments JSON source.');
      return { success: false, error: 'No input provided. Connect a comments JSON source.' };
    }

    try {
      await fs.access(textPath);
    } catch {
      onLog?.(`[TTS ElevenLabs] ERROR: Input file not found: ${textPath}`);
      return { success: false, error: `Input file not found: ${textPath}` };
    }

    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'ELEVENLABS_API_KEY');
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey?.trim()) {
      onLog?.(`[TTS ElevenLabs] ERROR: API key not set. Set env var: ${apiKeyEnvVar}`);
      return { success: false, error: `API key not set. Set environment variable: ${apiKeyEnvVar}` };
    }

    const voiceId = String(params.voiceId ?? '21m00Tcm4TlvDq8ikWAM').trim();
    let modelId = String(params.modelId ?? 'eleven_v3');
    if (modelId === 'eleven_multilingual_v3') modelId = 'eleven_v3';
    const outputFormat = String(params.outputFormat ?? 'mp3_44100_128');
    const stability = Math.max(0, Math.min(1, Number(params.stability) ?? 0.5));
    const similarityBoost = Math.max(0, Math.min(1, Number(params.similarityBoost) ?? 0.75));
    const trimOverlap = params.trimOverlap !== false;
    onLog?.('[TTS ElevenLabs] === Module start ===');
    onLog?.(`[TTS ElevenLabs] Input: "${textPath}"`);
    onLog?.(`[TTS ElevenLabs] Voice: ${voiceId}, Model: ${modelId}`);

    const raw = await fs.readFile(textPath, 'utf8');
    let segments: CommentSegment[];
    try {
      segments = JSON.parse(raw) as CommentSegment[];
      if (!Array.isArray(segments)) {
        throw new Error('Expected JSON array');
      }
    } catch (err) {
      onLog?.(`[TTS ElevenLabs] ERROR: Invalid JSON: ${(err as Error).message}`);
      return { success: false, error: `Invalid JSON input: ${(err as Error).message}` };
    }

    const validSegments = segments.filter((s) => s.text && typeof s.text === 'string');
    if (validSegments.length === 0) {
      onLog?.('[TTS ElevenLabs] ERROR: No valid text segments found');
      return { success: false, error: 'No valid text segments found in input JSON' };
    }

    onLog?.(`[TTS ElevenLabs] Found ${validSegments.length} segments to synthesize`);

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const segmentsDir = path.join(outDir, 'segments');
    await fs.mkdir(segmentsDir, { recursive: true });

    const client = new ElevenLabsClient({ apiKey });

    let totalChars = 0;
    const segmentPaths: string[] = [];
    const segmentStarts: number[] = [];

    for (let i = 0; i < validSegments.length; i++) {
      if (context.signal?.aborted) {
        onLog?.('[TTS ElevenLabs] Aborted');
        return { success: false, error: 'Aborted by user' };
      }

      const seg = validSegments[i];
      const startSec = parseTimeToSeconds(seg.time);
      segmentStarts.push(startSec);

      const pct = Math.round((i / validSegments.length) * 80);
      onProgress?.(pct, `Synthesizing segment ${i + 1}/${validSegments.length}`);
      onLog?.(`[TTS ElevenLabs] Segment ${i + 1}: "${seg.text.slice(0, 50)}${seg.text.length > 50 ? '...' : ''}" @ ${seg.time}`);

      const segPath = path.join(segmentsDir, `seg_${i.toString().padStart(3, '0')}.mp3`);

      try {
        const request: Record<string, unknown> = {
          text: seg.text,
          modelId,
          outputFormat: outputFormat as 'mp3_44100_128',
          voiceSettings: { stability, similarityBoost },
        };
        if (modelId !== 'eleven_v3') {
          request.previousText = validSegments[i - 1]?.text;
          request.nextText = validSegments[i + 1]?.text;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: audioStream, rawResponse } = await client.textToSpeech
          .convert(voiceId, request as any)
          .withRawResponse();

        const charCount = rawResponse.headers.get('x-character-count');
        if (charCount) {
          totalChars += parseInt(charCount, 10) || seg.text.length;
        } else {
          totalChars += seg.text.length;
        }

        await streamToFile(audioStream, segPath);
        segmentPaths.push(segPath);
      } catch (err) {
        onLog?.(`[TTS ElevenLabs] ERROR: ElevenLabs API failed for segment ${i + 1}: ${(err as Error).message}`);
        return { success: false, error: `ElevenLabs API failed: ${(err as Error).message}` };
      }
    }

    onProgress?.(82, 'Getting segment durations');
    const segmentDurations: number[] = [];
    for (let i = 0; i < segmentPaths.length; i++) {
      const dur = await getVideoDuration(segmentPaths[i], context.signal);
      segmentDurations.push(dur);
    }

    onProgress?.(85, 'Merging audio segments');
    onLog?.(`[TTS ElevenLabs] Cached segments dir: ${segmentsDir}`);
    onLog?.('[TTS ElevenLabs] Merging segments with timing...');

    const outputPath = path.join(outDir, 'output.mp3');

    const filterParts: string[] = [];
    const inputs: string[] = [];
    for (let i = 0; i < segmentPaths.length; i++) {
      inputs.push('-i', segmentPaths[i]);
      const delayMs = Math.round(segmentStarts[i] * 1000);
      let filterIn = `[${i}:a]`;
      if (trimOverlap && i < segmentPaths.length - 1) {
        const maxDur = segmentStarts[i + 1] - segmentStarts[i];
        if (maxDur > 0 && segmentDurations[i] > maxDur) {
          filterIn += `atrim=end=${maxDur},`;
          onLog?.(`[TTS ElevenLabs] Trimming segment ${i + 1} from ${segmentDurations[i].toFixed(2)}s to ${maxDur.toFixed(2)}s`);
        }
      }
      filterParts.push(`${filterIn}adelay=${delayMs}|${delayMs}[a${i}]`);
    }
    const mixInputs = segmentPaths.map((_, i) => `[a${i}]`).join('');
    // normalize=0: prevents amix from re-balancing volume as earlier segments end
    filterParts.push(`${mixInputs}amix=inputs=${segmentPaths.length}:duration=longest:normalize=0[aout]`);
    const filterComplex = filterParts.join(';');

    const ok = await new Promise<boolean>((resolve) => {
      const args = [
        '-y',
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[aout]',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        outputPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      if (context.signal) {
        if (context.signal.aborted) {
          proc.kill();
          return resolve(false);
        }
        context.signal.addEventListener('abort', () => {
          proc.kill();
          resolve(false);
        }, { once: true });
      }

      proc.on('error', (err) => {
        onLog?.(`[TTS ElevenLabs] FFmpeg spawn error: ${err}`);
        resolve(false);
      });
      proc.on('close', (code) => resolve(code === 0));

      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(false);
      }, 300_000);
    });

    if (!ok) {
      onLog?.('[TTS ElevenLabs] ERROR: FFmpeg merge failed');
      return { success: false, error: 'FFmpeg merge failed' };
    }

    const stat = await fs.stat(outputPath);
    onLog?.(`[TTS ElevenLabs] Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);

    // ElevenLabs API pricing: https://elevenlabs.io/pricing/api
    // Multilingual v2/v3: $0.12 per 1K chars (Business tier)
    // Flash/Turbo: $0.06 per 1K chars (Business tier)
    const costPer1kChars = modelId.includes('flash') || modelId.includes('turbo') ? 0.06 : 0.12;
    const costUsd = (totalChars / 1000) * costPer1kChars;

    const metadata = {
      provider: 'elevenlabs',
      modelId,
      voiceId,
      characters: totalChars,
      segments: validSegments.length,
      costUsd: Math.round(costUsd * 10000) / 10000,
    };
    await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    onProgress?.(100, 'Done');
    onLog?.('[TTS ElevenLabs] === Module complete ===');

    return {
      success: true,
      context: {
        currentAudioPath: outputPath,
      },
    };
  }
}
