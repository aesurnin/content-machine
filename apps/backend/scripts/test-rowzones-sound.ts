/**
 * Test script to verify Rowzones sound hypotheses.
 *
 * Run (headless):  npx tsx scripts/test-rowzones-sound.ts
 * Run (visible):   npx tsx scripts/test-rowzones-sound.ts --headed
 *
 * Tests:
 * 1. localStorage: set muted:false BEFORE load via evaluateOnNewDocument
 * 2. URL params: ?muted=0&sound=1&audio=1
 * 3. DOM/JS: unmute HTML5 audio, Phaser, Howler
 *
 * If sound works with --headed, the localStorage approach is the solution.
 */

import puppeteer from 'puppeteer';

const TEST_URL = 'https://static-r2-fr.rowzones.com/gm/index.html?partner=replay&lang=en&gameName=4_pots_riches&key=replay-2512168000151277288';

async function main() {
  const browser = await puppeteer.launch({
    headless: process.argv.includes('--headed') ? false : 'new', // Use --headed to see browser
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const gameName = new URL(TEST_URL).searchParams.get('gameName') || '4_pots_riches';
  const page2 = await browser.newPage();

  // Test 0: Set localStorage BEFORE load via evaluateOnNewDocument (game reads it on init)
  await page2.evaluateOnNewDocument((gameKey: string) => {
    try {
      const existing = localStorage.getItem(gameKey);
      const obj = existing ? JSON.parse(existing) : {};
      obj.muted = false;
      obj.music_volume = 1;
      obj.sfx_volume = 1;
      obj.sound_enabled = true;
      localStorage.setItem(gameKey, JSON.stringify(obj));
    } catch {}
  }, gameName);

  // Test 1: Try URL with sound params
  const urlWithSound = new URL(TEST_URL);
  urlWithSound.searchParams.set('muted', '0');
  urlWithSound.searchParams.set('sound', '1');
  urlWithSound.searchParams.set('audio', '1');

  console.log('Loading with sound params:', urlWithSound.toString());
  await page2.goto(urlWithSound.toString(), { waitUntil: 'networkidle2', timeout: 30000 });

  await new Promise((r) => setTimeout(r, 8000)); // Wait for game to load

  // Check frames (game might be in iframe)
  const frames = page2.frames();
  console.log('Frames count:', frames.length);

  // Test 2: Inspect page for audio/sound
  const pageInfo = await page2.evaluate(() => {
    // Check all frames
    const iframes = document.querySelectorAll('iframe');
    const iframeSrcs = Array.from(iframes).map((f) => (f as HTMLIFrameElement).src?.slice(0, 80));
    const audio = document.querySelectorAll('audio');
    const info: Record<string, unknown> = {
      iframeSrcs,
      audioCount: audio.length,
      audioElements: Array.from(audio).map((a) => ({
        muted: a.muted,
        paused: a.paused,
        src: a.src?.slice(0, 80),
      })),
      windowKeys: Object.keys(window).filter((k) =>
        /sound|audio|mute|phaser|pixi|howler|game/i.test(k)
      ),
      localStorage: {} as Record<string, string>,
    };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) info.localStorage[k] = localStorage.getItem(k) ?? '';
      }
    } catch {}
    return info;
  });
  console.log('\n--- Page info ---');
  console.log(JSON.stringify(pageInfo, null, 2));

  // Test 3: Try JS unmute
  const unmuteResult = await page2.evaluate(() => {
    const results: string[] = [];
    try {
      document.querySelectorAll('audio').forEach((a, i) => {
        a.muted = false;
        a.volume = 1;
        results.push(`audio[${i}]: unmuted`);
      });
    } catch (e) {
      results.push(`audio error: ${e}`);
    }
    try {
      const g = (window as any).game;
      if (g?.sound) {
        g.sound.mute = false;
        results.push('Phaser game.sound.mute = false');
      }
    } catch {}
    try {
      const h = (window as any).Howler;
      if (h) {
        h.mute(false);
        results.push('Howler.mute(false)');
      }
    } catch {}
    return results;
  });
  console.log('\n--- Unmute attempts ---');
  console.log(unmuteResult);

  console.log('\n--- Summary ---');
  console.log('localStorage was pre-set with muted:false. Run with --headed to verify sound.');
  console.log('If sound plays: use evaluateOnNewDocument + localStorage in screencast worker.');
  console.log('\nKeep browser open 30s - check if sound plays. Then close.');
  await new Promise((r) => setTimeout(r, 30000));
  await page2.close();
  await browser.close();
}

main().catch(console.error);
