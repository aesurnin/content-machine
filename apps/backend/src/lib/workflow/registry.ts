import type { WorkflowModule, ModuleMeta } from './types.js';
import { VideoCompressorModule } from './modules/video-compressor.js';
import { VideoCropModule } from './modules/video-crop.js';
import { OpenRouterVisionModule } from './modules/openrouter-vision.js';
import { VideoClipCutterModule } from './modules/video-clip-cutter.js';
import { LlmAgentModule } from './modules/llm-agent.js';
import { TtsElevenlabsModule } from './modules/tts-elevenlabs.js';
import { VideoRenderRemotionModule } from './modules/video-render-remotion.js';
import { LlmScenarioGeneratorModule } from './modules/llm-scenario-generator.js';
import { AudioLibrarySelectModule } from './modules/audio-library-select.js';
import { HeyGenAvatarVideoModule } from './modules/heygen-avatar-video.js';
import { FalVeedFabricAvatarModule } from './modules/fal-veed-fabric-avatar.js';
import { SttElevenlabsModule } from './modules/stt-elevenlabs.js';

const modules = new Map<string, WorkflowModule>();

function register(m: WorkflowModule) {
  modules.set(m.meta.type, m);
}

register(new VideoCompressorModule());
register(new VideoCropModule());
register(new OpenRouterVisionModule());
register(new VideoClipCutterModule());
register(new LlmAgentModule());
register(new TtsElevenlabsModule());
register(new VideoRenderRemotionModule());
register(new LlmScenarioGeneratorModule());
register(new AudioLibrarySelectModule());
register(new HeyGenAvatarVideoModule());
register(new FalVeedFabricAvatarModule());
register(new SttElevenlabsModule());

export function getModule(type: string): WorkflowModule | undefined {
  return modules.get(type);
}

export function listModules(): ModuleMeta[] {
  return Array.from(modules.values()).map((m) => m.meta);
}
