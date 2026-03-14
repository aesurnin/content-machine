import '../load-env.js';
import { Worker } from 'bullmq';
import { launch, getStream } from 'puppeteer-stream';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { screencastQueue, type ScreencastJobData } from '../lib/queue.js';

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
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';
const PREVIEW_INTERVAL_MS = 500;
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;
const MIN_VIEWPORT_WIDTH = 640;
const MIN_VIEWPORT_HEIGHT = 360;
const MAX_VIEWPORT_WIDTH = 1920;
const MAX_VIEWPORT_HEIGHT = 1080;

// Window position off-screen so it does not steal focus or expand to fullscreen (headed mode required for proper rendering)
const WINDOW_POSITION = process.env.SCREENCAST_WINDOW_POSITION || '9999,9999';

async function resolveUrl(url: string): Promise<{ finalUrl: string; isHtml: boolean }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return { finalUrl: res.url, isHtml: (res.headers.get('content-type') || '').includes('text/html') };
}

const DEFAULT_PLAY_SELECTORS = [
  '#playBtn', 'button#playBtn', 'button[aria-label*="play" i]', '[data-action="play"]', '[data-action="start"]',
  'button.play', '.play-btn', '.play-button', '[class*="play"]', '[class*="Play"]', 'button[title*="play" i]',
  '[role="button"][aria-label*="play" i]', 'video + button', '[class*="replay"] button', '[class*="Replay"] button',
  '.replay-controls button', '[class*="playback"] button', 'button',
];

class JobCancelledError extends Error {
  constructor() { super('Job cancelled by user'); this.name = 'JobCancelledError'; }
}

async function isJobCancelled(videoId: string): Promise<boolean> {
  const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
  return !v || v.status === 'cancelled';
}

async function detectContentSize(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<{ width: number; height: number }> {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (canvas && (canvas as HTMLCanvasElement).width > 0 && (canvas as HTMLCanvasElement).height > 0) {
      return { width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height };
    }
    for (const sel of ['.game-container', '[class*="replay"]', '[class*="Replay"]', '#game', '.game']) {
      const el = document.querySelector(sel);
      if (el && el instanceof HTMLElement) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    }
    const w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, window.innerWidth);
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
    return { width: w || 1280, height: h || 720 };
  }) as { width: number; height: number };
  
  let { width, height } = result;
  
  // Ensure dimensions are even (required by some encoders)
  width = width % 2 === 0 ? width : width + 1;
  height = height % 2 === 0 ? height : height + 1;

  return {
    width: Math.max(MIN_VIEWPORT_WIDTH, Math.min(MAX_VIEWPORT_WIDTH, width)),
    height: Math.max(MIN_VIEWPORT_HEIGHT, Math.min(MAX_VIEWPORT_HEIGHT, height)),
  };
}

async function injectFitCSS(page: { evaluate: (fn: () => void) => Promise<void> }): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      * { 
        margin: 0 !important; 
        padding: 0 !important; 
        overflow: hidden !important; 
      }
      html, body { 
        background: black !important;
        width: 100vw !important;
        height: 100vh !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
      } 
      canvas, video, iframe, .game-container, [class*="game"], [class*="replay"], [class*="Replay"] { 
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important; 
        height: 100vh !important; 
        max-width: none !important;
        max-height: none !important;
        object-fit: fill !important; 
        z-index: 999999 !important;
      }
    `;
    document.head.appendChild(style);
    
    // Prevent any scrolling attempts
    window.scrollTo(0, 0);
    window.addEventListener('scroll', (e) => {
      window.scrollTo(0, 0);
      e.preventDefault();
    }, { passive: false });
  });
}

/** Injects a MutationObserver that continuously hides/clicks the "not optimized for your browser" dialog. */
async function injectBrowserCompatibilityDialogRemover(
  frame: { evaluate: (fn: () => void) => Promise<unknown> }
): Promise<void> {
  await frame.evaluate(() => {
    const marker = 'not optimized for your browser';
    const markerAlt = 'for better experience use safari';
    function hideOrDismiss(el: Element): boolean {
      const t = (el.textContent || '').toLowerCase();
      if (!t.includes(marker) && !t.includes(markerAlt)) return false;
      const container = el.closest('div[class*="modal"], div[class*="dialog"], div[class*="overlay"], [role="dialog"]') || el;
      const buttons = container.querySelectorAll('button, [role="button"], a, [class*="button"]');
      for (const b of buttons) {
        if ((b.textContent || '').trim().toUpperCase() === 'OK') {
          (b as HTMLElement).click();
          return true;
        }
      }
      (container as HTMLElement).style.setProperty('display', 'none');
      (container as HTMLElement).style.setProperty('visibility', 'hidden');
      (container as HTMLElement).style.setProperty('opacity', '0');
      (container as HTMLElement).style.setProperty('pointer-events', 'none');
      return true;
    }
    function scan(root: Document | Element | ShadowRoot): boolean {
      const iter = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let el: Element | null;
      while ((el = iter.nextNode() as Element | null)) {
        if (hideOrDismiss(el)) return true;
        const shadow = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (shadow && scan(shadow)) return true;
      }
      return false;
    }
    const obs = new MutationObserver(() => { scan(document); });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scan(document);
  });
}

const DEFAULT_UNMUTE_SELECTORS = [
  '[aria-label*="mute" i]', '[aria-label*="unmute" i]', '[aria-label*="sound" i]', '[aria-label*="volume" i]',
  'button[class*="mute"]', 'button[class*="volume"]', 'button[class*="sound"]',
  '[class*="mute"][role="button"]', '[class*="volume"][role="button"]', '[class*="sound"][role="button"]',
  '[role="graphics-symbol"]', // Rowzones uses this for the speaker icon
];

async function tryClickUnmute(ctx: { $: (s: string) => Promise<{ click: () => Promise<void>; dispose: () => void } | null>; evaluate: (fn: () => boolean) => Promise<boolean> }, selectors: string[]): Promise<{ clicked: boolean; selector?: string }> {
  for (const sel of selectors) {
    try {
      const el = await ctx.$(sel);
      if (el) { await el.click(); el.dispose(); return { clicked: true, selector: sel }; }
    } catch { /* next */ }
  }
  try {
    const ok = await ctx.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="graphics-symbol"], [class*="mute"], [class*="volume"], [class*="sound"]'));
      const muteBtn = candidates.find((b) => {
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        const cls = (b.className || '').toLowerCase();
        return (
          label.includes('mute') || label.includes('unmute') || label.includes('sound') || label.includes('volume') ||
          title.includes('mute') || title.includes('sound') || title.includes('volume') ||
          cls.includes('mute') || cls.includes('volume') || cls.includes('sound')
        );
      });
      if (muteBtn && muteBtn instanceof HTMLElement) { muteBtn.click(); return true; }
      return false;
    });
    return { clicked: ok, selector: ok ? '(evaluate)' : undefined };
  } catch { return { clicked: false }; }
}

async function tryClickPlay(ctx: { $: (s: string) => Promise<{ click: () => Promise<void>; dispose: () => void } | null>; evaluate: (fn: () => boolean) => Promise<boolean> }, selectors: string[]): Promise<{ clicked: boolean; selector?: string }> {
  for (const sel of selectors) {
    try {
      const el = await ctx.$(sel);
      if (el) { await el.click(); el.dispose(); return { clicked: true, selector: sel }; }
    } catch { /* next */ }
  }
  try {
    const ok = await ctx.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="play"], [class*="Play"]'));
      const play = buttons.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        return (t === 'play' || label.includes('play') || title.includes('play')) && !t.includes('replay');
      });
      if (play && play instanceof HTMLElement) { play.click(); return true; }
      return false;
    });
    return { clicked: ok, selector: ok ? '(evaluate)' : undefined };
  } catch { return { clicked: false }; }
}

async function clickPlayButton(
  page: { frames: () => { $: (s: string) => Promise<unknown>; evaluate: (fn: () => boolean) => Promise<boolean> }[]; waitForSelector: (s: string, o: { timeout: number; visible: boolean }) => Promise<unknown>; waitForFunction: (fn: () => boolean, o: { timeout: number }) => Promise<unknown>; evaluate: (fn: () => boolean) => Promise<boolean>; mouse: { click: (x: number, y: number) => Promise<void> } },
  videoId: string, playSelectors: string[] | undefined, viewportWidth: number, viewportHeight: number, log: (m: string) => void
): Promise<boolean> {
  const selectors = playSelectors?.length ? playSelectors : DEFAULT_PLAY_SELECTORS;
  log('[Play] Waiting for #playBtn or preloader...');
  for (let i = 0; i < 10; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try { await page.waitForSelector('#playBtn', { timeout: 2000, visible: true }); log('[Play] Found #playBtn'); break; }
    catch { if (i === 9) log('[Play] #playBtn not found'); }
  }
  for (let i = 0; i < 5; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try { await page.waitForFunction(() => { const p = document.querySelector('.preloader'); return !p || (p as HTMLElement).offsetParent === null; }, { timeout: 2000 }); break; }
    catch { /* continue */ }
  }
  if (await isJobCancelled(videoId)) throw new JobCancelledError();
  await new Promise((r) => setTimeout(r, 1000));
  for (const frame of page.frames()) {
    try {
      const r = await tryClickPlay(frame as Parameters<typeof tryClickPlay>[0], selectors);
      if (r.clicked) { log(`[Play] OK: ${r.selector}`); return true; }
    } catch (e) { log(`[Play] Frame: ${e}`); }
  }
  try {
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button, [role="button"], div[class*="play"], span[class*="play"]');
      for (const el of all) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if ((txt === 'play' || (cls.includes('play') && !cls.includes('replay')) || label.includes('play')) && el instanceof HTMLElement) {
          el.click(); return true;
        }
      }
      return false;
    });
    if (clicked) return true;
  } catch { /* fallback */ }
  try { await page.mouse.click(viewportWidth / 2, viewportHeight / 2); return true; } catch { return false; }
}

function startLivePreview(page: { screenshot: (o: { type: string; quality: number }) => Promise<Buffer> }, videoId: string, log: (m: string) => void): () => void {
  if (!BACKEND_URL || !PREVIEW_SECRET) { log('Live preview disabled'); return () => {}; }
  const url = `${BACKEND_URL.replace(/\/$/, '')}/internal/live-preview/${videoId}`;
  let lastErr = 0;
  const id = setInterval(async () => {
    try {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Preview-Token': PREVIEW_SECRET }, body: Buffer.from(jpeg) });
      if (!res.ok && Date.now() - lastErr > 30000) { lastErr = Date.now(); log(`Preview ${res.status}`); }
    } catch (e) { if (Date.now() - lastErr > 30000) { lastErr = Date.now(); log(`Preview: ${e}`); } }
  }, PREVIEW_INTERVAL_MS);
  return () => clearInterval(id);
}

/**
 * Get BGaming freespins data from page.
 * BGaming stores spin result in sessionStorage under keys like "latestSpinResultV2" + hash.
 * Value is JSON with features.freespins_left. Also fallback to localStorage "replay-mode".
 */
async function getBGamingSpinDataFromPage(
  page: { evaluate: (fn: () => unknown) => Promise<unknown>; frames?: () => { evaluate: (fn: () => unknown) => Promise<unknown> }[] }
): Promise<{ freespinsLeft: number | undefined; rawValue: string } | null> {
  const frames = page.frames ? page.frames() : [page];
  for (const frame of frames) {
    try {
      const result = await frame.evaluate(() => {
        try {
          const ss = (window as any).sessionStorage;
          if (ss) {
            for (let i = 0; i < ss.length; i++) {
              const k = ss.key(i);
              if (k && (k.includes('latestSpinResult') || k.includes('latestSpinResultV2'))) {
                const raw = ss.getItem(k);
                if (raw) {
                  try {
                    const obj = JSON.parse(raw) as Record<string, unknown>;
                    const features = obj?.features as Record<string, unknown> | undefined;
                    const freespinsLeft = features?.freespins_left as number | undefined;
                    return { freespinsLeft, rawValue: raw };
                  } catch { /* skip invalid JSON */ }
                }
              }
            }
          }
          const ls = (window as any).localStorage;
          if (ls) {
            for (let i = 0; i < ls.length; i++) {
              const k = ls.key(i);
              if (k && k.startsWith('replay-mode')) {
                const raw = ls.getItem(k);
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw) as Record<string, unknown>;
                    const resultKey = Object.keys(parsed).find((key) =>
                      key.startsWith('latestSpinResult')
                    );
                    const spinData = resultKey ? (parsed[resultKey] as Record<string, unknown>) : null;
                    const features = spinData?.features as Record<string, unknown> | undefined;
                    const freespinsLeft = features?.freespins_left as number | undefined;
                    return { freespinsLeft, rawValue: raw };
                  } catch { /* skip */ }
                }
              }
            }
          }
          return null;
        } catch { return null; }
      }) as { freespinsLeft: number | undefined; rawValue: string } | null;
      if (result) return result;
    } catch { /* cross-origin or frame gone */ }
  }
  return null;
}

async function waitForReplayEnd(
  page: {
    evaluate: (fn: (a: unknown) => unknown, a?: unknown) => Promise<unknown>;
    frames?: () => { evaluate: (fn: () => unknown) => Promise<unknown> }[];
    on: (event: string, handler: (msg: { text: () => string }) => void) => void;
    off: (event: string, handler: (msg: { text: () => string }) => void) => void;
  },
  videoId: string,
  jobData: { url: string; endSelectors?: string[]; durationLimit?: number; idleValueSelector?: string; idleSeconds?: number; consoleEndPatterns?: string[] },
  log: (m: string) => void
): Promise<'cancelled' | 'stop' | 'done' | 'idle'> {
  const { endSelectors, durationLimit = 600, idleValueSelector, idleSeconds = 40, consoleEndPatterns } = jobData;
  const start = Date.now();
  const poll = 500;
  let lastIdleValue: string | null = null;
  let lastIdleChange = Date.now();
  const recentConsole: string[] = [];
  const maxConsoleLines = 50;
  let lastStateLogTime = 0;
  const STATE_LOG_INTERVAL_MS = 2000;

  // Detect BGaming replay URLs
  const isBGamingReplay = jobData.url.includes('bgaming-network.com/api/replays');
  let lastRowzonesDialogCheck = 0;
  let lastReplayModeValue: string | null = null;
  let lastReplayModeChange = Date.now();
  let freespinsEndedAt: number | null = null;
  let debugLoggedStructure = false;

  const consoleHandler = (msg: { text: () => string }) => {
    try {
      const text = msg.text();
      recentConsole.push(text);
      if (recentConsole.length > maxConsoleLines) recentConsole.shift();
    } catch { /* ignore */ }
  };
  page.on('console', consoleHandler);

  try {
    return await new Promise((resolve) => {
      const check = async () => {
        const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
        if (!v || v.status === 'cancelled') { 
          log('[AutoStop] Reason: Job cancelled in database');
          resolve('cancelled'); 
          return; 
        }
        const meta = v?.metadata as { stopRequested?: boolean } | null;
        if (meta?.stopRequested) { 
          log('[AutoStop] Reason: Manual stop requested by user');
          resolve('stop'); 
          return; 
        }
        
        const elapsed = (Date.now() - start) / 1000;
        if (elapsed >= durationLimit) { 
          log(`[AutoStop] Reason: Duration limit reached (${elapsed.toFixed(0)}s >= ${durationLimit}s)`);
          resolve('done'); 
          return; 
        }

        // BGaming replay: check sessionStorage (latestSpinResultV2) and localStorage (replay-mode)
        if (isBGamingReplay) {
          try {
            const spinData = await getBGamingSpinDataFromPage(page as Parameters<typeof getBGamingSpinDataFromPage>[0]);

            if (spinData) {
              const { freespinsLeft, rawValue } = spinData;

              if (rawValue !== lastReplayModeValue) {
                lastReplayModeValue = rawValue;
                lastReplayModeChange = Date.now();
              }

              if (!debugLoggedStructure && elapsed > 5) {
                debugLoggedStructure = true;
                log(`[BGaming] freespins_left: ${freespinsLeft ?? 'n/a'} (from sessionStorage/localStorage)`);
              }

              const idleSec = (Date.now() - lastReplayModeChange) / 1000;
              const now = Date.now();
              if (now - lastStateLogTime >= STATE_LOG_INTERVAL_MS) {
                lastStateLogTime = now;
                if (freespinsEndedAt !== null) {
                  const waitSec = (now - freespinsEndedAt) / 1000;
                  log(`[AutoStop] freespins_left: 0, idle: ${idleSec.toFixed(0)}s | after 0: ${waitSec.toFixed(0)}s/30s`);
                } else {
                  log(`[AutoStop] freespins_left: ${freespinsLeft ?? 'n/a'}, idle: ${idleSec.toFixed(0)}s`);
                }
              }

              // Freespins: freespins_left === 0
              if (freespinsLeft === 0 && freespinsEndedAt === null) {
                freespinsEndedAt = Date.now();
                log('[AutoStop] BGaming freespins ended (freespins_left === 0), waiting 30s for animations...');
              }

              if (freespinsEndedAt !== null) {
                const waitMs = Date.now() - freespinsEndedAt;
                if (waitMs >= 30000) {
                  const reason = `BGaming replay ended (waited 30s after freespins_left === 0)`;
                  log(`[AutoStop] Reason: ${reason}`);
                  await db.update(videoEntities)
                    .set({ metadata: { ...((v?.metadata as any) || {}), stopReason: reason } })
                    .where(eq(videoEntities.id, videoId));
                  resolve('done');
                  return;
                }
              }

              // Regular spin (no freespins): fall through to idleValueSelector (Idle 40s on total-win per provider)
            }
          } catch (e) { 
            log(`[BGaming] Check error: ${e}`);
          }
        }

        // Rowzones: periodically try to dismiss browser compatibility dialog during recording
        const isRowzones = jobData.url.includes('rowzones.com');
        if (isRowzones && Date.now() - lastRowzonesDialogCheck > 2000) {
          lastRowzonesDialogCheck = Date.now();
          const frames = page.frames ? page.frames() : [page];
          for (const frame of frames) {
            try {
              await frame.evaluate(() => {
                const marker = 'not optimized for your browser';
                const markerAlt = 'for better experience use safari';
                const markers = [marker, markerAlt, 'safari', 'el capitan', 'browser'];
                const hide = (el: Element) => {
                  const container = el.closest('div[class*="modal"], div[class*="dialog"], div[class*="overlay"], [role="dialog"]') || el;
                  const buttons = container.querySelectorAll('button, [role="button"], a, [class*="button"]');
                  for (const b of buttons) {
                    if ((b.textContent || '').trim().toUpperCase() === 'OK') {
                      (b as HTMLElement).click();
                      return;
                    }
                  }
                  (container as HTMLElement).style.cssText += 'display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;';
                };
                const cx = window.innerWidth / 2;
                const cy = window.innerHeight / 2;
                const atCenter = document.elementsFromPoint(cx, cy);
                for (const el of atCenter) {
                  const t = (el.textContent || '').toLowerCase();
                  if (markers.some((m) => t.includes(m))) { hide(el); return; }
                }
                const walk = (root: Document | Element | ShadowRoot): boolean => {
                  const iter = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
                  let el: Element | null;
                  while ((el = iter.nextNode() as Element | null)) {
                    const t = (el.textContent || '').toLowerCase();
                    if (markers.some((m) => t.includes(m))) { hide(el); return true; }
                    const shadow = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
                    if (shadow && walk(shadow)) return true;
                  }
                  return false;
                };
                walk(document);
              });
            } catch { /* cross-origin */ }
          }
        }

        if (endSelectors?.length) {
          try {
            const frames = page.frames ? page.frames() : [page];
            let found = false;
            for (const frame of frames) {
              try {
                found = await frame.evaluate((s: string[]) => s.some((sel) => !!document.querySelector(sel)), endSelectors) as boolean;
                if (found) break;
              } catch { /* cross-origin or frame gone */ }
            }
            if (found) { 
              const reason = `endSelector matched (${endSelectors.join(', ')})`;
              log(`[AutoStop] Reason: ${reason}`);
              await db.update(videoEntities)
                .set({ metadata: { ...((v?.metadata as any) || {}), stopReason: reason } })
                .where(eq(videoEntities.id, videoId));
              resolve('done'); 
              return; 
            }
          } catch { /* page gone */ }
        }

        // Rowzones: check for "Replay Summary" text in all frames (game is often in iframe)
        if (jobData.url.includes('rowzones.com')) {
          try {
            const frames = page.frames ? page.frames() : [page];
            let hasReplaySummary = false;
            for (const frame of frames) {
              try {
                hasReplaySummary = await frame.evaluate(() => {
                  const text = (document.body?.textContent || '').toLowerCase();
                  return (
                    text.includes('replay summary') ||
                    text.includes('copy the replay url') ||
                    text.includes('would you like to copy')
                  );
                }) as boolean;
                if (hasReplaySummary) break;
              } catch { /* cross-origin or frame gone */ }
            }
            if (hasReplaySummary) {
              const reason = 'Rowzones Replay Summary modal appeared';
              log(`[AutoStop] Reason: ${reason}`);
              await db.update(videoEntities)
                .set({ metadata: { ...((v?.metadata as any) || {}), stopReason: reason } })
                .where(eq(videoEntities.id, videoId));
              resolve('done');
              return;
            }
          } catch { /* page gone */ }
        }

        if (consoleEndPatterns?.length && recentConsole.length > 0) {
          const matched = consoleEndPatterns.find((p) =>
            recentConsole.some((msg) => msg.includes(p))
          );
          if (matched) {
            const reason = `Console pattern matched ("${matched}")`;
            log(`[AutoStop] Reason: ${reason}`);
            await db.update(videoEntities)
              .set({ metadata: { ...((v?.metadata as any) || {}), stopReason: reason } })
              .where(eq(videoEntities.id, videoId));
            resolve('done');
            return;
          }
        }

        if (idleValueSelector) {
          try {
            const current = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              return el ? (el.textContent || '').trim() : null;
            }, idleValueSelector) as string | null;
            if (current != null) {
              if (lastIdleValue !== current) {
                lastIdleValue = current;
                lastIdleChange = Date.now();
              }
              const idleMs = Date.now() - lastIdleChange;
              const idleSec = idleMs / 1000;
              const now = Date.now();
              if (now - lastStateLogTime >= STATE_LOG_INTERVAL_MS) {
                lastStateLogTime = now;
                log(`[AutoStop] idleValue: "${current}", unchanged: ${idleSec.toFixed(0)}s / ${idleSeconds}s`);
              }
              if (idleMs >= idleSeconds * 1000) {
                const reason = `Idle detection (selector "${idleValueSelector}" unchanged for ${(idleMs / 1000).toFixed(0)}s, value: "${current}")`;
                log(`[AutoStop] Reason: ${reason}`);
                await db.update(videoEntities)
                  .set({ metadata: { ...((v?.metadata as any) || {}), stopReason: reason } })
                  .where(eq(videoEntities.id, videoId));
                resolve('idle');
                return;
              }
            }
          } catch { /* selector invalid or page gone */ }
        }

        setTimeout(check, poll);
      };
      check();
    });
  } finally {
    page.off('console', consoleHandler);
  }
}

async function convertWebmToMp4(webmPath: string, mp4Path: string): Promise<boolean> {
  return new Promise((resolve) => {
    // WebM uses VP8/Opus; MP4 needs H.264/AAC. Re-encode instead of copy.
    const proc = spawn('ffmpeg', [
      '-y', '-i', webmPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      mp4Path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 120_000);
  });
}

function createWorkerLog(videoId: string): (m: string) => void {
  const prefix = `[${videoId.slice(0, 8)}]`;
  const logsUrl = BACKEND_URL && PREVIEW_SECRET
    ? `${BACKEND_URL.replace(/\/$/, '')}/internal/logs/${videoId}`
    : null;
  return (m: string) => {
    const line = `${prefix} ${m}`;
    console.log(line);
    if (logsUrl) {
      fetch(logsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Preview-Token': PREVIEW_SECRET,
        },
        body: JSON.stringify({ message: m }),
      }).catch(() => {});
    }
  };
}

async function runScreencastJob(jobData: ScreencastJobData): Promise<void> {
  const { projectId, videoId, url, durationLimit = 600, endSelectors, playSelectors } = jobData;
  const log = createWorkerLog(videoId);
  log('Job started');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screencast-'));
  const webmPath = path.join(tmpDir, 'output.webm');
  const mp4Path = path.join(tmpDir, 'output.mp4');
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  let stopPreview = () => {};
  try {
    const [v0] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v0 || v0.status === 'cancelled') return;
    const { finalUrl, isHtml } = await resolveUrl(url);
    log(`URL: ${finalUrl}`);
    if (!isHtml) log(`Warning: URL pre-check did not return text/html (will try loading in browser anyway): ${finalUrl}`);
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    // headless: 'new' = no visible window (macOS ignores --window-position). Set SCREENCAST_HEADLESS=false for visible window.
    const useHeadless = process.env.SCREENCAST_HEADLESS !== 'false';
    const vw = 1920;
    const vh = 1080;
    
    log(`Launch config: headless=new, BACKEND_URL=${BACKEND_URL}, res=${vw}x${vh}@2x`);

    browser = await launch({
      headless: 'new',
      executablePath,
      ignoreDefaultArgs: ['--enable-automation', '--mute-audio'],
      defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2 },
      startDelay: 2000,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--autoplay-policy=no-user-gesture-required',
        '--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli',
        `--window-size=${vw},${vh}`,
        '--force-device-scale-factor=2',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--disable-features=IsolateOrigins,site-per-process',
        '--auto-accept-this-tab-capture',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--headless=new',
        '--enable-audio-service-audio-streams',
      ],
    });
    log('Browser launched');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    const page = await browser.newPage();
    log('New page created');

    const isRowzones = jobData.url.includes('rowzones.com');
    let gameName: string | null = null;
    if (isRowzones) {
      try {
        gameName = new URL(jobData.url).searchParams.get('gameName');
      } catch {}
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      await page.evaluateOnNewDocument((gName: string | null) => {
        const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
        try {
          Object.defineProperty(navigator, 'userAgent', { get: () => safariUA, configurable: true });
          Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.', configurable: true });
          Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
          Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
          (window as any).safari = { pushNotification: {} };
          delete (window as any).chrome;
        } catch (_) {}
        if (gName) {
          try {
            const existing = localStorage.getItem(gName);
            const obj = existing ? JSON.parse(existing) : {};
            obj.muted = false;
            obj.music_volume = 1;
            obj.sfx_volume = 1;
            obj.sound_enabled = true;
            localStorage.setItem(gName, JSON.stringify(obj));
          } catch (_) {}
        }
      }, gameName);
      log(`[Rowzones] Set Safari UA + localStorage sound for gameName=${gameName ?? 'auto'}`);
    }

    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    log('Going to URL...');
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    log('Page loaded');
    await page.bringToFront();
    
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    log('Injecting CSS...');
    await injectFitCSS(page);

    // Crucial: Wait 5 seconds for the layout and capture extension to stabilize
    await new Promise((r) => setTimeout(r, 5000));

    if (isRowzones) {
      const injectDialogRemover = async () => {
        const frames = page.frames ? page.frames() : [page];
        for (const frame of frames) {
          try {
            await injectBrowserCompatibilityDialogRemover(frame);
          } catch { /* cross-origin iframe */ }
        }
      };
      await injectDialogRemover();
      log('[Rowzones] Injected dialog remover');
    }

    // Rowzones: unmute before recording
    if (isRowzones) {
      const unmuteSelectors = jobData.unmuteSelectors?.length ? jobData.unmuteSelectors : DEFAULT_UNMUTE_SELECTORS;
      log('[Unmute] Rowzones: trying to enable sound...');
      let unmuted = false;
      for (const frame of page.frames()) {
        try {
          const r = await tryClickUnmute(frame as Parameters<typeof tryClickUnmute>[0], unmuteSelectors);
          if (r.clicked) { log(`[Unmute] OK: ${r.selector}`); unmuted = true; break; }
        } catch (e) { log(`[Unmute] Frame: ${e}`); }
      }
      if (!unmuted) {
        try {
          const clicked = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="graphics-symbol"]'));
            const muteBtn = candidates.find((b) => {
              const label = (b.getAttribute('aria-label') || '').toLowerCase();
              const cls = (b.className || '').toLowerCase();
              return label.includes('mute') || label.includes('sound') || label.includes('volume') || cls.includes('mute') || cls.includes('volume');
            });
            if (muteBtn && muteBtn instanceof HTMLElement) { muteBtn.click(); return true; }
            return false;
          });
          if (clicked) { log('[Unmute] OK (evaluate)'); unmuted = true; }
        } catch { /* ignore */ }
      }
      if (!unmuted) log('[Unmute] Could not find mute/sound button');
      await new Promise((r) => setTimeout(r, 500));
    }

    log('Starting capture...');
    
    stopPreview = startLivePreview(page, videoId, log);
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    
    const stream = await getStream(page, { 
      audio: true, 
      video: true, 
      videoBitsPerSecond: 8_000_000, 
      audioBitsPerSecond: 128_000
    });
    log('Stream captured');

    // Stream directly to FFmpeg for real-time MP4 encoding (as in the old pipeline)
    const ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-i', '-', // Read from stdin
      '-c:v', 'libx264', 
      '-preset', 'ultrafast', // Faster encoding to keep up with the stream
      '-crf', '18',          // Better quality (lower is better)
      '-c:a', 'aac', 
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',  // Standard pixel format for compatibility
      '-movflags', 'frag_keyframe+empty_moov',
      mp4Path,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Log FFmpeg output to diagnose audio issues
    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Audio:') || msg.includes('Stream #') || msg.includes('error')) {
        log(`[FFmpeg] ${msg.trim()}`);
      }
    });

    stream.pipe(ffmpegProcess.stdin);

    if (!jobData.skipPlayClick && !isRowzones) {
      await clickPlayButton(page, videoId, playSelectors, vw, vh, log);
      await new Promise((r) => setTimeout(r, 1000));
    } else if (isRowzones) {
      log('[Play] Rowzones: animation starts immediately, skipping play click');
    } else {
      log('[Play] skipPlayClick=true, skipping play button');
    }
    log('Recording...');
    const result = await waitForReplayEnd(page, videoId, jobData, log);
    log(`Stopped: ${result}`);
    
    stream.destroy();
    ffmpegProcess.stdin.end();

    // Wait for FFmpeg to finish encoding
    await new Promise((resolve) => {
      ffmpegProcess.on('close', resolve);
      setTimeout(resolve, 5000); // safety timeout
    });

    if (browser) { await browser.close(); browser = null; }
    if (result === 'cancelled') return;
    await new Promise((r) => setTimeout(r, 1000));
    
    let finalPath = mp4Path;
    let contentType = 'video/mp4';

    // Verify MP4 was created and has size
    try {
      const stat = await fs.stat(mp4Path);
      if (stat.size < 1000) throw new Error('MP4 too small');
    } catch {
      log('MP4 encoding failed or too small, no output');
      return;
    }

    const buffer = await fs.readFile(finalPath);
    if (!BACKEND_URL || !PREVIEW_SECRET) throw new Error('BACKEND_URL and SCREENCAST_PREVIEW_SECRET required');
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/internal/upload-video/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Preview-Token': PREVIEW_SECRET, 'X-Project-Id': projectId },
      body: buffer,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    if (err instanceof JobCancelledError) return;
    const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v || v.status === 'cancelled') return;
    await db.update(videoEntities).set({ status: 'failed', metadata: { error: String(err) } }).where(eq(videoEntities.id, videoId));
    throw err;
  } finally {
    stopPreview();
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const worker = new Worker<ScreencastJobData>('screencast', async (job) => {
  console.log('[Worker] Job', job.id, 'videoId=', job.data?.videoId?.slice(0, 8));
  await runScreencastJob(job.data);
}, { connection: { ...redisOpts, maxRetriesPerRequest: null }, concurrency: 1 });

worker.on('active', (j) => console.log('[Worker] Active', j.id));
worker.on('completed', (j) => console.log('[Worker] Completed', j.id));
worker.on('failed', (j, e) => console.error('[Worker] Failed', j?.id, e));
worker.on('error', (e) => console.error('[Worker] Error', e));

// Clean up stale jobs on startup (jobs that were active when worker crashed)
(async () => {
  try {
    const activeJobs = await screencastQueue.getActive();
    console.log(`[Worker] Cleaning ${activeJobs.length} stale jobs from previous run...`);
    for (const job of activeJobs) {
      if (job.data?.videoId) {
        await db.update(videoEntities)
          .set({ status: 'failed', metadata: { error: 'Worker restarted' } })
          .where(eq(videoEntities.id, job.data.videoId));
      }
      await job.moveToFailed(new Error('Worker restarted'), job.token || '');
    }
  } catch (err) {
    console.error('[Worker] Failed to clean stale jobs:', err);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Worker] SIGTERM received, closing...');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Worker] SIGINT received, closing...');
  await worker.close();
  process.exit(0);
});

console.log('Screencast worker started. REDIS=%s:%d', redisOpts.host, redisOpts.port);
