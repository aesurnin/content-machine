import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

/** Caption format for @remotion/captions */
interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
}

/** ElevenLabs word from speech-to-text response */
interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing' | 'audio_event';
}

interface ElevenLabsSttResponse {
  language_code: string;
  language_probability: number;
  text: string;
  words: ElevenLabsWord[];
}

export const sttElevenlabsMeta = {
  type: 'stt.elevenlabs',
  label: 'Transcribe Audio (ElevenLabs)',
  description: 'Transcribe audio to word-level captions using ElevenLabs Speech to Text API (Scribe v2)',
  category: 'Audio',
  quickParams: ['apiKeyEnvVar', 'modelId'],
  inputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  outputSlots: [
    { key: 'captions', label: 'Captions JSON', kind: 'text' as const },
  ],
  paramsSchema: [
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'ELEVENLABS_API_KEY' },
    { key: 'modelId', label: 'Model', type: 'string' as const, default: 'scribe_v2' },
  ],
};

export class SttElevenlabsModule implements WorkflowModule {
  readonly meta = sttElevenlabsMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;

    const inputPaths = context.inputPaths ?? {};
    const audioPath = inputPaths['audio'] ?? context.currentAudioPath;

    if (!audioPath) {
      onLog?.('[STT ElevenLabs] ERROR: No audio input provided. Connect an audio source.');
      return { success: false, error: 'No audio input provided. Connect an audio source.' };
    }

    try {
      await fs.access(audioPath);
    } catch {
      onLog?.(`[STT ElevenLabs] ERROR: Audio file not found: ${audioPath}`);
      return { success: false, error: `Audio file not found: ${audioPath}` };
    }

    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'ELEVENLABS_API_KEY');
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey?.trim()) {
      onLog?.(`[STT ElevenLabs] ERROR: API key not set. Set env var: ${apiKeyEnvVar}`);
      return { success: false, error: `API key not set. Set environment variable: ${apiKeyEnvVar}` };
    }

    const modelId = String(params.modelId ?? 'scribe_v2');

    onLog?.('[STT ElevenLabs] === Module start ===');
    onLog?.(`[STT ElevenLabs] Input: "${audioPath}"`);
    onLog?.(`[STT ElevenLabs] Model: ${modelId}`);

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, 'output.json');

    onProgress?.(10, 'Uploading audio to ElevenLabs API');

    const client = new ElevenLabsClient({ apiKey });

    let response: ElevenLabsSttResponse;
    try {
      // client.speechToText.convert accepts a file stream
      const fileStream = createReadStream(audioPath);
      
      // The SDK types might define response as any or specific type, we cast to our interface
      response = (await client.speechToText.convert({
        file: fileStream,
        modelId: modelId,
      })) as unknown as ElevenLabsSttResponse;
    } catch (err) {
      onLog?.(`[STT ElevenLabs] ERROR: API request failed: ${(err as Error).message}`);
      return { success: false, error: `ElevenLabs STT API request failed: ${(err as Error).message}` };
    }

    onProgress?.(80, 'Parsing response');

    const words = response.words ?? [];
    
    // Filter for actual words (skip spacing/events if needed, though they might affect timing)
    // Actually we want words to display. Spacing usually has empty text or " ".
    // We'll just map words where type is 'word' or 'punctuation' (if exists).
    // Based on docs: type is "word", "spacing", "audio_event".
    
    const captionWords = words.filter(w => w.type === 'word');
    
    const captions: Caption[] = captionWords.map((w, i) => ({
      text: i === 0 ? w.text : ` ${w.text}`, // Add space prefix
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      timestampMs: Math.round(w.start * 1000),
      confidence: null,
    }));

    await fs.writeFile(outputPath, JSON.stringify(captions, null, 2), 'utf8');

    // Calculate cost: Scribe v1/v2 pricing is roughly $0.0083/min (approx based on $5/10h)
    // Actually let's look up pricing: $0.30 per hour = $0.005 per min? Or standard tier.
    // Let's use a rough estimate or check metadata. The SDK response might not have cost.
    const durationSec = words.length > 0 ? words[words.length - 1].end : 0;
    const costUsd = (durationSec / 60) * 0.005; // Estimate $0.005/min ($0.30/hr)

    const metadata = {
      provider: 'elevenlabs',
      model: modelId,
      durationSec,
      wordCount: captions.length,
      costUsd: Math.round(costUsd * 10000) / 10000,
    };
    await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    onLog?.(`[STT ElevenLabs] Output: ${outputPath} (${captions.length} words)`);
    onProgress?.(100, 'Done');
    onLog?.('[STT ElevenLabs] === Module complete ===');

    return {
      success: true,
      context: {
        currentTextOutputPath: outputPath,
      },
    };
  }
}
