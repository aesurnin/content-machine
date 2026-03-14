/**
 * Central workflow variable resolver.
 *
 * All modules resolve variables through this "table": variable name -> path/value.
 * Resolution uses the current workflow definition: variable name -> which module produces it -> path from that module's cache.
 *
 * When you rename a variable (e.g. video_crop -> video_cropped), the workflow def updates.
 * Resolution still works: we look up the producer module from the workflow and get the path from cache.
 * The link is preserved because we resolve by workflow structure, not by stored variable names.
 */

import fs from 'fs/promises';
import path from 'path';
import type { WorkflowModuleDef } from './types.js';
import { getModule } from './registry.js';

const MODULE_ID_FILE = '.module-id';
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];
const TEXT_EXT = ['.txt', '.md', '.json'];
const FILE_EXT = ['.mp3', '.wav', '.m4a', '.ogg'];

function getWorkflowCacheBase(): string {
  const base = process.env.WORKFLOW_CACHE_BASE;
  if (base) return base;
  return path.join(process.cwd(), 'workflow-cache');
}

function getCacheFolderName(moduleType: string, moduleId: string): string {
  const typeSlug = moduleType.replace(/\./g, '-');
  const shortId = moduleId.split('_').pop()?.slice(0, 8) ?? moduleId.slice(-8);
  return `${typeSlug}-${shortId}`;
}

async function resolveModuleCacheDir(videoDir: string, moduleId: string): Promise<string | null> {
  const entries = await fs.readdir(videoDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(videoDir, e.name);
    const metaPath = path.join(dirPath, MODULE_ID_FILE);
    try {
      const stored = await fs.readFile(metaPath, 'utf8');
      if (stored.trim() === moduleId) return dirPath;
    } catch {
      if (e.name === moduleId) return dirPath;
    }
  }
  return null;
}

export async function findOutputInCacheDir(dirPath: string, kind: 'video' | 'text' | 'file'): Promise<string | null> {
  const exts = kind === 'video' ? VIDEO_EXT : kind === 'text' ? TEXT_EXT : FILE_EXT;
  const names = kind === 'video' ? ['output', 'crop_output'] : ['output'];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const name of names) {
      for (const ext of exts) {
        const full = `${name}${ext}`;
        const p = path.join(dirPath, full);
        try {
          const stat = await fs.stat(p);
          if (stat.isFile()) return p;
        } catch {
          /* skip */
        }
      }
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (exts.includes(ext)) return path.join(dirPath, e.name);
    }
  } catch {
    /* dir missing or unreadable */
  }

  // Fallback to R2
  const isR2Configured = process.env.R2_BUCKET_NAME && process.env.R2_ENDPOINT;
  if (isR2Configured) {
    try {
      // dirPath is something like: /app/workflow-cache/projectId/videoId/folderName
      const parts = dirPath.split(path.sep);
      const folderName = parts.pop();
      const videoId = parts.pop();
      const projectId = parts.pop();
      if (projectId && videoId && folderName) {
        // We can't import listObjectsFromR2 easily due to circular/dependency issues unless we import it
        // Let's dynamically import to avoid top-level issues if any
        const { listObjectsFromR2 } = await import('../r2.js');
        const prefix = `projects/${projectId}/videos/${videoId}/workflow-cache/${folderName}/`;
        const keys = await listObjectsFromR2(prefix);
        for (const name of names) {
          for (const ext of exts) {
            const full = `${name}${ext}`;
            if (keys.includes(prefix + full)) {
              return path.join(dirPath, full);
            }
          }
        }
        for (const key of keys) {
          const fileName = key.slice(prefix.length);
          if (fileName.includes('/')) continue;
          const ext = path.extname(fileName).toLowerCase();
          if (exts.includes(ext)) return path.join(dirPath, fileName);
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export interface ResolveVariablesOptions {
  /** Local path for source video (required for 'source' variable) */
  sourcePath?: string;
  /** Only resolve variables from steps 0..endExclusive. Default: all modules. */
  endExclusive?: number;
  /** Existing variables to merge (e.g. from previousContext). These take precedence. */
  existing?: Record<string, string>;
  onLog?: (msg: string) => void;
}

/**
 * Resolve workflow variables to local file paths.
 * Uses workflow definition as source of truth: variable name -> producer module -> cache path.
 * Safe for variable renames: resolution follows workflow structure.
 */
export async function resolveWorkflowVariables(
  projectId: string,
  videoId: string,
  workflow: { modules: WorkflowModuleDef[] },
  options: ResolveVariablesOptions = {}
): Promise<Record<string, string>> {
  const { sourcePath, endExclusive = workflow.modules.length, existing = {}, onLog } = options;
  const modules = workflow.modules;
  const variables: Record<string, string> = { ...existing };

  if (sourcePath) {
    variables.source = sourcePath;
  }

  const cacheBase = getWorkflowCacheBase();
  const videoDir = path.join(cacheBase, projectId, videoId);

  for (let i = 0; i < endExclusive && i < modules.length; i++) {
    const def = modules[i];
    const mod = getModule(def.type);
    if (!mod || !def.outputs) continue;

    let moduleCacheDir = await resolveModuleCacheDir(videoDir, def.id);
    if (!moduleCacheDir) {
      const folderName = getCacheFolderName(def.type, def.id);
      moduleCacheDir = path.join(videoDir, folderName);
    }

    for (const [slotKey, varName] of Object.entries(def.outputs)) {
      if (variables[varName]) continue;
      const meta = mod.meta as { outputSlots?: { key: string; kind: string }[] };
      const slot = meta?.outputSlots?.find((s) => s.key === slotKey);
      const kind = slot?.kind === 'text' ? 'text' : slot?.kind === 'file' ? 'file' : 'video';
      const outPath = await findOutputInCacheDir(moduleCacheDir, kind);
      if (outPath) {
        try {
          await fs.stat(outPath);
        } catch {
          // File not found locally, might be on R2
          const isR2Configured = process.env.R2_BUCKET_NAME && process.env.R2_ENDPOINT;
          if (isR2Configured) {
            try {
              const relPath = path.relative(path.join(getWorkflowCacheBase(), projectId, videoId), outPath).split(path.sep).join('/');
              // relPath looks like folderName/output.mp4
              const r2Key = `projects/${projectId}/videos/${videoId}/workflow-cache/${relPath}`;
              const { getObjectFromR2 } = await import('../r2.js');
              const buffer = await getObjectFromR2(r2Key);
              await fs.mkdir(path.dirname(outPath), { recursive: true });
              await fs.writeFile(outPath, buffer);
              onLog?.(`[VariableResolver] Downloaded missing ${varName} from R2`);
            } catch (err) {
              onLog?.(`[VariableResolver] Failed to download ${varName} from R2: ${err}`);
            }
          }
        }

        variables[varName] = outPath;
        onLog?.(`[VariableResolver] ${varName} <- ${path.basename(moduleCacheDir)}/${path.basename(outPath)}`);
      }
    }
  }

  return variables;
}

/**
 * Resolve variables for API (returns cache info for URL building).
 * Same resolution logic, but returns { folderName, fileName } for each variable.
 */
export async function resolveWorkflowVariablesForApi(
  projectId: string,
  videoId: string,
  workflow: { modules: WorkflowModuleDef[] }
): Promise<Record<string, { folderName: string; fileName: string; isText?: boolean }>> {
  const modules = workflow.modules;
  const result: Record<string, { folderName: string; fileName: string; isText?: boolean }> = {};
  const cacheBase = getWorkflowCacheBase();
  const videoDir = path.join(cacheBase, projectId, videoId);

  for (let i = 0; i < modules.length; i++) {
    const def = modules[i];
    const mod = getModule(def.type);
    if (!mod || !def.outputs) continue;

    let moduleCacheDir = await resolveModuleCacheDir(videoDir, def.id);
    if (!moduleCacheDir) {
      const folderName = getCacheFolderName(def.type, def.id);
      moduleCacheDir = path.join(videoDir, folderName);
    }
    const folderName = path.basename(moduleCacheDir);

    for (const [slotKey, varName] of Object.entries(def.outputs)) {
      const meta = mod.meta as { outputSlots?: { key: string; kind: string }[] };
      const slot = meta?.outputSlots?.find((s) => s.key === slotKey);
      const kind = slot?.kind === 'text' ? 'text' : slot?.kind === 'file' ? 'file' : 'video';
      const outPath = await findOutputInCacheDir(moduleCacheDir, kind);
      if (outPath) {
        result[varName] = {
          folderName,
          fileName: path.basename(outPath),
          isText: kind === 'text',
        };
      }
    }
  }

  return result;
}
