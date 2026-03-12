#!/usr/bin/env node
/**
 * Run the full production stack locally in Docker.
 * Mirrors VPS deployment for testing. No screencast worker.
 *
 * Usage: npm run docker:prod
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['-f', 'docker-compose.prod.yml'];

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

async function main() {
  const envPath = path.join(rootDir, '.env');
  const envExamplePath = path.join(rootDir, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example. Fill in R2 credentials.');
  }

  console.log('Starting Postgres and Redis...');
  await run('docker', ['compose', ...COMPOSE, 'up', '-d', 'postgres', 'redis']);

  console.log('Waiting for Postgres to accept connections...');
  await new Promise((r) => setTimeout(r, 4000));

  console.log('Running database migrations...');
  await run('docker', ['compose', ...COMPOSE, '--profile', 'init', 'run', '--rm', 'db-migrate']);

  console.log('Building and starting Backend, Frontend, Traefik...');
  await run('docker', ['compose', ...COMPOSE, 'up', '-d', '--build']);

  console.log('');
  console.log('Stack is running. Open http://localhost (or http://localhost:80)');
  console.log('To stop: docker compose -f docker-compose.prod.yml down');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
