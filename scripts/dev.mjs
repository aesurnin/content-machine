#!/usr/bin/env node

import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: rootDir,
      shell: true,
      ...opts,
    });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

function tcpConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection(port, host, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, label, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await tcpConnect('127.0.0.1', port)) {
      console.log(`${label} is ready.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready in time.`);
}

async function main() {
  const envPath = path.join(rootDir, '.env');
  const envExamplePath = path.join(rootDir, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example. Fill in R2 credentials for uploads.');
  }

  const env = loadEnv();
  const strategy = env.RECORDING_STRATEGY || 'puppeteer-stream';
  const useStreamWorker = strategy === 'puppeteer-stream';

  const redisPort = parseInt(env.REDIS_PORT || '6380', 10);
  const backendPort = parseInt(env.PORT || '3001', 10);
  process.env.PORT = String(backendPort);

  if (useStreamWorker) {
    console.log('Starting Docker (postgres, redis only — worker runs locally)...');
    await run('docker-compose', ['stop', 'screencast-worker']).catch(() => {});
    await run('docker-compose', ['up', '-d', 'postgres', 'redis']);
  } else {
    console.log('Starting Docker (postgres, redis, screencast-worker)...');
    await run('docker-compose', ['up', '-d']);
  }

  console.log('Waiting for Redis...');
  await waitForPort(redisPort, 'Redis');

  console.log('Docker services:');
  await run('docker-compose', ['ps']);

  console.log('Applying DB schema...');
  await run('npm', ['run', 'db:push']);

  let backendProc = null;
  const killAll = () => {
    if (backendProc?.pid) {
      try {
        process.kill(backendProc.pid, 'SIGTERM');
      } catch (_) {}
    }
  };
  process.on('SIGINT', killAll);
  process.on('SIGTERM', killAll);

  if (useStreamWorker) {
    console.log('Starting backend first (frontend will wait for it)...');
    const workerEnv = [
      `BACKEND_URL=http://localhost:${backendPort}`,
      env.SCREENCAST_PREVIEW_SECRET ? `SCREENCAST_PREVIEW_SECRET=${env.SCREENCAST_PREVIEW_SECRET}` : '',
    ].filter(Boolean).join(' ');
    backendProc = spawn('npm', ['run', 'dev:backend'], {
      stdio: 'inherit',
      cwd: rootDir,
      shell: true,
      env: process.env,
    });
    await waitForPort(backendPort, 'Backend');
    await run(
      `npx concurrently -n frontend,worker -c green,magenta "npm run dev:frontend" "${workerEnv} npm run worker"`,
      []
    );
  } else {
    console.log('Starting backend first...');
    backendProc = spawn('npm', ['run', 'dev:backend'], {
      stdio: 'inherit',
      cwd: rootDir,
      shell: true,
      env: process.env,
    });
    await waitForPort(backendPort, 'Backend');
    console.log('Starting frontend...');
    await run('npm', ['run', 'dev:frontend']);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
