import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';
import {
  resolvePromptPlaceholders,
  callOpenRouter,
  resolveJsonPlaceholders,
} from './utils.js';

// ---------------------------------------------------------------------------
// System prompt for LLM - JSON format with slots and scene
// MUST stay in sync with apps/backend/remotion-template/src/SceneComposition.tsx
// See .cursor/rules/remotion-scenario-schema.mdc
// ---------------------------------------------------------------------------

const SCENARIO_SYSTEM_PROMPT = `You generate JSON scenario definitions for video composition. Your response MUST be a single valid JSON object.

SCHEMA (use ONLY these fields — others are ignored):

{
  "slots": [
    { "key": "main_video", "kind": "video", "label": "Main Video" },
    { "key": "voice_input", "kind": "file", "label": "Voice Input" },
    { "key": "background_music", "kind": "file", "label": "Background Music" },
    { "key": "voice_captions", "kind": "text", "label": "Voice Captions JSON" }
  ],
  "scene": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "durationInFrames": 300,
    "backgroundColor": "#0a0a0a",
    "blurredBackground": true,
    "blurredBackgroundRadius": 40,
    "blurredBackgroundScale": 1.2,
    "blurredBackgroundVolume": 0,
    "clips": [
      { "type": "video", "src": "{{slot_key}}", "from": 0, "durationInFrames": 90, "layout": "cover", "volume": 1 },
      { "type": "text", "text": "Literal text or {{slot_key}}", "from": 0, "durationInFrames": 90, "position": "bottom", "fontSize": 48, "color": "#ffffff" },
      { "type": "audio", "src": "{{voice_input}}", "from": 0, "durationInFrames": 180, "volume": 1 },
      { "type": "audio", "src": "{{background_music}}", "from": 0, "durationInFrames": 180, "volume": 0.5 },
      { "type": "subtitle", "from": 0, "durationInFrames": 180, "captions": "{{voice_captions}}", "position": "bottom", "combineTokensWithinMs": 1200, "fontFamily": "reels", "fontSize": 36 }
    ]
  }
}

SCENE-LEVEL (in "scene" object):
- width, height, fps, durationInFrames: numbers
- backgroundColor: CSS color string (default "#0a0a0a")
- blurredBackground: boolean — when true, first video clip is rendered as scaled+blurred background layer
- blurredBackgroundRadius: number (px, default 40)
- blurredBackgroundScale: number (>1 = zoomed, default 1.2)
- blurredBackgroundVolume: number (0 to 1, default 0)

VIDEO CLIP (type "video"):
- src: "{{slot_key}}" (required), from, durationInFrames
- layout: "fill" | "contain" | "cover" (optional, default "contain")
- volume: number (0 = mute, 1 = normal, >1 = amplify, e.g. 1.5 or 2, optional, default 1)
- x: number — horizontal offset as % of scene width; negative = left, positive = right (optional, default 0)
- y: number — vertical offset as % of scene height; negative = up, positive = down (optional, default 0)
- scale: number — scale factor; 1 = natural size, 0.5 = half size, 2 = double size (optional, default 1)
- opacity: number — 0 (transparent) to 1 (fully opaque) (optional, default 1)

TEXT CLIP (type "text"):
- text: string (literal or "{{slot_key}}" for variable), from, durationInFrames
- position: "bottom" | "top" | "center" (optional)
- fontSize: number (optional)
- color: CSS color string (optional)

SUBTITLE CLIP (type "subtitle"):
- from: number (start frame), durationInFrames: number (total duration of subtitle track)
- captions: "{{voice_captions}}" — placeholder for word-level captions JSON. Add slot { "key": "voice_captions", "kind": "text", "label": "Voice Captions JSON" }. Connect the "Transcribe Audio (ElevenLabs)" module output to this slot. Format: [{ text: " word", startMs, endMs, timestampMs, confidence }]
- combineTokensWithinMs: number — milliseconds window to group words into one display page (optional, default 1200). Lower = more word-by-word, higher = more words per page.
- position: "bottom" | "top" | "center" | "bottom-left" | "bottom-right" | "top-left" | "top-right" (optional, default "bottom")
- positionOffset: number — px from edge (optional, default 40)
- x: number — horizontal offset as % from center; negative = left, positive = right (0 = center). When set with y, overrides position.
- y: number — vertical offset as % from center; negative = up, positive = down (0 = center). When set with x, overrides position.
- fontSize: number (optional, default 36)
- color: CSS hex color for inactive words (optional, default "#ffffff")
- activeColor: CSS hex color for currently spoken word (optional, default "#FFD700")
- bgColor: CSS hex color for background box (optional, default "#000000")
- bgOpacity: number 0–1 for background box opacity (optional, default 0.75)
- fontFamily: "reels" | "clean" | "bold" or CSS font-family string (optional, default "reels") — reels = Bebas Neue (bold), clean = Montserrat, bold = Oswald

AUDIO CLIP (type "audio"):
- src: "{{slot_key}}", from, durationInFrames
- volume: number (0 = mute, 1 = normal, >1 = amplify, e.g. 1.5 or 2, optional, default 1)

MULTIPLE AUDIO:
- You MAY add multiple audio clips (e.g. voice_input for narration, background_music for music).
- Each audio clip needs its own slot in "slots" with kind "file".
- Example slots: main_video (video), voice_input (file), background_music (file).

CAPTIONS SLOT:
- When scenario has subtitles, add slot { "key": "voice_captions", "kind": "text", "label": "Voice Captions JSON" } and use "captions": "{{voice_captions}}" in the subtitle clip.
- The connected file is a JSON array of word-level Caption objects. Use the "Transcribe Audio (ElevenLabs)" module: connect audio (from TTS or other source) to it, then connect its captions output to voice_captions.

RULES:
- "slots" defines variables the user connects. Each slot: key, kind (video|text|file), label.
- Use {{slot_key}} placeholders in src/text — system substitutes with file paths.
- Respond with ONLY the JSON object. No markdown, no explanation.`;

// ---------------------------------------------------------------------------
// Module metadata
// ---------------------------------------------------------------------------

export const llmScenarioGeneratorMeta = {
  type: 'llm.scenario.generator',
  label: 'LLM Scenario Generator',
  description: 'Generate JSON scenario from a prompt via LLM. Output has slots for connecting variables (videos, audio).',
  category: 'LLM',
  quickParams: ['model', 'prompt'],
  inputSlots: [
    { key: 'context', label: 'Context (optional)', kind: 'text' as const },
  ],
  outputSlots: [
    { key: 'text', label: 'Scenario JSON', kind: 'text' as const },
  ],
  paramsSchema: [
    {
      key: 'sceneJson',
      label: 'Scenario JSON (manual or from Generate)',
      type: 'json' as const,
      default: '',
    },
    {
      key: 'prompt',
      label: 'Scenario prompt (for Generate)',
      type: 'prompt' as const,
      default: 'Create a video montage with 3 clips. Use slots clip_1, clip_2, clip_3 for the three video sources.',
    },
    {
      key: 'apiKeyEnvVar',
      label: 'API key (env var name)',
      type: 'string' as const,
      default: 'OPENROUTER_API_KEY',
    },
    {
      key: 'model',
      label: 'Model',
      type: 'string' as const,
      default: 'google/gemini-2.0-flash-001',
    },
    {
      key: 'temperature',
      label: 'Temperature',
      type: 'number' as const,
      default: 0.5,
      min: 0,
      max: 2,
    },
    {
      key: 'maxTokens',
      label: 'Max tokens',
      type: 'number' as const,
      default: 4096,
      min: 256,
      max: 32000,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJsonFromResponse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  // Try direct parse
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object') return obj;
  } catch {
    /* continue */
  }
  // Extract from markdown code block
  const codeBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlock) {
    try {
      const obj = JSON.parse(codeBlock[1].trim());
      if (obj && typeof obj === 'object') return obj;
    } catch {
      /* continue */
    }
  }
  // Find first { ... }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(trimmed.slice(start, i + 1));
            if (obj && typeof obj === 'object') return obj;
          } catch {
            /* continue */
          }
          break;
        }
      }
    }
  }
  return null;
}

function hashCacheKey(prompt: string, model: string, params: Record<string, unknown>): string {
  const payload = JSON.stringify({ prompt, model, temperature: params.temperature, maxTokens: params.maxTokens });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export interface GenerateScenarioPreviewParams {
  prompt: string;
  contextText?: string;
  apiKeyEnvVar?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateScenarioPreviewResult {
  success: true;
  json: Record<string, unknown>;
  slots: Array<{ key: string; kind: string; label?: string }>;
}

export interface GenerateScenarioPreviewError {
  success: false;
  error: string;
}

/**
 * Generate scenario JSON from prompt via LLM without running the full workflow.
 * Use for preview before connecting variables.
 */
export async function generateScenarioPreview(
  params: GenerateScenarioPreviewParams
): Promise<GenerateScenarioPreviewResult | GenerateScenarioPreviewError> {
  const prompt = String(params.prompt ?? '').trim();
  const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'OPENROUTER_API_KEY').trim();
  const model = String(params.model ?? 'google/gemini-2.0-flash-001').trim();
  const temperature = Math.max(0, Math.min(2, Number(params.temperature) ?? 0.5));
  const maxTokens = Math.max(256, Math.min(32000, Number(params.maxTokens) ?? 4096));

  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    return { success: false, error: `Env variable "${apiKeyEnvVar}" is not set. Add it in Env Manager.` };
  }

  const userMessage = params.contextText
    ? `Current scenario (modify according to the task below):\n${params.contextText}\n\nTask: ${prompt}\n\nReturn the complete updated JSON scenario.`
    : prompt;

  const result = await callOpenRouter({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SCENARIO_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    maxTokens,
    temperature,
    timeoutMs: 60_000,
  });

  if ('error' in result) {
    return { success: false, error: result.error };
  }

  const rawJson = extractJsonFromResponse(result.text);
  if (!rawJson) {
    return { success: false, error: 'LLM did not return valid JSON. Try again or adjust the prompt.' };
  }

  const slots = Array.isArray(rawJson.slots) ? rawJson.slots : [];
  const scene = rawJson.scene;

  if (!scene || typeof scene !== 'object') {
    return { success: false, error: 'LLM response missing "scene" object. Check the prompt.' };
  }

  const normalizedSlots = slots
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object')
    .map((s) => ({
      key: String(s.key ?? ''),
      kind: String(s.kind ?? 'video'),
      label: typeof s.label === 'string' ? s.label : undefined,
    }))
    .filter((s) => s.key);

  return {
    success: true,
    json: rawJson,
    slots: normalizedSlots,
  };
}

// ---------------------------------------------------------------------------
// Module implementation
// ---------------------------------------------------------------------------

export class LlmScenarioGeneratorModule implements WorkflowModule {
  readonly meta = llmScenarioGeneratorMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};
    const outDir = context.moduleCacheDir ?? context.tempDir;

    onLog?.('[ScenarioGenerator] === Module start ===');

    const sceneJsonInline = String(params.sceneJson ?? '').trim();
    let rawJson: Record<string, unknown> | null = null;

    if (sceneJsonInline) {
      onLog?.('[ScenarioGenerator] Using inline scene JSON');
      try {
        rawJson = JSON.parse(sceneJsonInline) as Record<string, unknown>;
      } catch (e) {
        onLog?.(`[ScenarioGenerator] ERROR: Invalid inline JSON: ${e}`);
        return { success: false, error: 'Invalid inline scene JSON. Fix the syntax or clear it to use LLM generation.' };
      }
    }

    if (!rawJson) {
      const promptTemplate = String(params.prompt ?? 'Create a video montage with 3 clips. Use slots clip_1, clip_2, clip_3 for the three video sources.').trim();
      const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'OPENROUTER_API_KEY').trim();
      const model = String(params.model ?? 'google/gemini-2.0-flash-001').trim();
      const temperature = Math.max(0, Math.min(2, Number(params.temperature) ?? 0.5));
      const maxTokens = Math.max(256, Math.min(32000, Number(params.maxTokens) ?? 4096));

      const apiKey = process.env[apiKeyEnvVar];
      if (!apiKey) {
        onLog?.(`[ScenarioGenerator] ERROR: API key env var "${apiKeyEnvVar}" is not set.`);
        return { success: false, error: `Env variable "${apiKeyEnvVar}" is not set. Add it in Env Manager.` };
      }

      const prompt = await resolvePromptPlaceholders(promptTemplate, context.variables);

      const contextPath = inputPaths['context'] ?? context.currentTextOutputPath;
      let contextText = '';
      if (contextPath) {
        try {
          contextText = await fs.readFile(contextPath, 'utf8');
          onLog?.(`[ScenarioGenerator] Context loaded: ${contextText.length} chars`);
        } catch {
          onLog?.(`[ScenarioGenerator] WARNING: Could not read context from ${contextPath}`);
        }
      }

      const userMessage = contextText
        ? `Context:\n${contextText}\n\nTask: ${prompt}`
        : prompt;

      const cacheKey = hashCacheKey(prompt, model, { temperature, maxTokens });
      const llmCacheDir = path.join(outDir, 'llm-cache');
      const cachedPath = path.join(llmCacheDir, `${cacheKey}.json`);

      try {
        await fs.mkdir(llmCacheDir, { recursive: true });
        const cached = await fs.readFile(cachedPath, 'utf8');
        rawJson = JSON.parse(cached) as Record<string, unknown>;
        onLog?.(`[ScenarioGenerator] Using cached LLM output (key: ${cacheKey})`);
      } catch {
        /* no cache, call LLM */
      }

      if (!rawJson) {
      onProgress?.(10, 'Calling LLM');
      onLog?.(`[ScenarioGenerator] Calling OpenRouter: ${model}`);

      const result = await callOpenRouter({
        apiKey,
        model,
        messages: [
          { role: 'system', content: SCENARIO_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        maxTokens,
        temperature,
        signal: context.signal,
        timeoutMs: 60_000,
        onLog,
      });

      if ('error' in result) {
        onLog?.(`[ScenarioGenerator] LLM call failed: ${result.error}`);
        return { success: false, error: result.error };
      }

      rawJson = extractJsonFromResponse(result.text);
      if (!rawJson) {
        onLog?.(`[ScenarioGenerator] ERROR: Could not parse JSON from LLM response`);
        return { success: false, error: 'LLM did not return valid JSON. Try again or adjust the prompt.' };
      }

      await fs.writeFile(cachedPath, JSON.stringify(rawJson, null, 2), 'utf8');
      onLog?.(`[ScenarioGenerator] Cached LLM output to ${cacheKey}.json`);

      if (result.usage) {
        const metaPath = path.join(outDir, 'metadata.json');
        const metadata = {
          model,
          tokenUsage: result.usage,
        };
        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
      }
      }
    }

    const slots = Array.isArray(rawJson.slots) ? rawJson.slots : [];
    const scene = rawJson.scene;

    if (!scene || typeof scene !== 'object') {
      onLog?.(`[ScenarioGenerator] ERROR: JSON missing "scene" object`);
      return { success: false, error: 'LLM response missing "scene" object. Check the prompt.' };
    }

    onProgress?.(70, 'Substituting variables');

    // Resolve subtitle captions from file when captions is "{{slot_key}}" and slot is connected
    const sceneRecord = scene as Record<string, unknown>;
    const sceneClips = (sceneRecord['clips'] ?? []) as Array<Record<string, unknown>>;
    for (let i = 0; i < sceneClips.length; i++) {
      const clip = sceneClips[i];
      if (clip?.type === 'subtitle' && typeof clip.captions === 'string') {
        const match = (clip.captions as string).match(/^\{\{([A-Za-z0-9_]+)\}\}$/);
        if (match) {
          const slotKey = match[1];
          const filePath = context.inputPaths?.[slotKey] ?? context.variables?.[slotKey];
          if (filePath && typeof filePath === 'string') {
            try {
              const content = await fs.readFile(path.resolve(filePath), 'utf8');
              const parsed = JSON.parse(content) as unknown;
              const captions = Array.isArray(parsed)
                ? parsed
                : (parsed as Record<string, unknown>)?.captions ?? [];
              sceneClips[i] = { ...clip, captions };
              onLog?.(`[ScenarioGenerator] Loaded ${Array.isArray(captions) ? captions.length : 0} caption words from ${slotKey}`);
            } catch (e) {
              onLog?.(`[ScenarioGenerator] WARNING: Could not load captions file from ${slotKey}: ${e}`);
            }
          }
        }
      }
    }

    // Convert local paths to API URLs so output.json has portable links (not server-specific paths)
    const cacheBase = path.resolve(process.env.WORKFLOW_CACHE_BASE || path.join(process.cwd(), 'workflow-cache'));
    const substitutionVars: Record<string, string> = {};
    for (const [key, localPath] of Object.entries(context.inputPaths ?? {})) {
      if (typeof localPath !== 'string' || !localPath) continue;
      const absPath = path.resolve(localPath);
      const cachePrefix = path.join(cacheBase, context.projectId!, context.videoId!);
      if (absPath.startsWith(cachePrefix)) {
        const rel = path.relative(cachePrefix, absPath);
        const parts = rel.split(path.sep).filter(Boolean);
        const folderName = parts[0] ?? path.basename(path.dirname(localPath));
        const fileName = parts.slice(1).join(path.sep) || path.basename(localPath);
        substitutionVars[key] = `/api/projects/${context.projectId}/videos/${context.videoId}/workflow-cache/${encodeURIComponent(folderName)}/file?path=${encodeURIComponent(fileName)}`;
      } else {
        substitutionVars[key] = localPath;
      }
    }

    const resolvedScene = resolveJsonPlaceholders(scene, substitutionVars) as Record<string, unknown>;
    const outputJson = { ...rawJson, scene: resolvedScene };
    const outputPath = path.join(outDir, 'output.json');
    await fs.writeFile(outputPath, JSON.stringify(outputJson, null, 2), 'utf8');
    onLog?.(`[ScenarioGenerator] Output saved: ${outputPath}`);

    const slotsPath = path.join(outDir, 'slots.json');
    await fs.writeFile(slotsPath, JSON.stringify({ slots }, null, 2), 'utf8');
    onLog?.(`[ScenarioGenerator] Slots saved: ${slotsPath} (${slots.length} slots)`);

    onProgress?.(100, 'Done');
    onLog?.('[ScenarioGenerator] === Module complete ===');

    return {
      success: true,
      context: {
        currentTextOutputPath: outputPath,
      },
    };
  }
}
