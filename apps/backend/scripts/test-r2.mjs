#!/usr/bin/env node
/**
 * Test R2 connection. Run from apps/backend: node scripts/test-r2.mjs
 * Requires: npm install dotenv (or run with node --env-file=.env)
 */
import 'dotenv/config';
import https from 'https';
import { S3Client, ListBucketsCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const BUCKET = process.env.R2_BUCKET_NAME;
const ENDPOINT = process.env.R2_ENDPOINT;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;

console.log('R2 config check:');
console.log('  R2_BUCKET_NAME:', BUCKET ? `${BUCKET} (${BUCKET.length} chars)` : 'MISSING');
console.log('  R2_ENDPOINT:', ENDPOINT || 'MISSING');
console.log('  R2_ACCESS_KEY_ID:', ACCESS_KEY ? `${ACCESS_KEY.slice(0, 8)}... (${ACCESS_KEY.length} chars)` : 'MISSING');
console.log('  R2_SECRET_ACCESS_KEY:', SECRET_KEY ? '*** (set)' : 'MISSING');
console.log('');

if (!BUCKET || !ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
  console.error('ERROR: Missing required env vars. Check .env file.');
  process.exit(1);
}

const httpsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  rejectUnauthorized: true,
  keepAlive: false,
});

const client = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({ httpsAgent }),
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

async function test() {
  try {
    console.log('1. Listing buckets (may fail for bucket-scoped tokens)...');
    try {
      const buckets = await client.send(new ListBucketsCommand({}));
      console.log('   OK. Buckets:', buckets.Buckets?.map(b => b.Name).join(', ') || '(none)');
      if (!buckets.Buckets?.some(b => b.Name === BUCKET)) {
        console.error(`   ERROR: Bucket "${BUCKET}" not found in account.`);
        process.exit(1);
      }
    } catch (e) {
      if (e.name === 'AccessDenied') {
        console.log('   Skipped (bucket-scoped token). Proceeding to upload test...');
      } else throw e;
    }

    console.log('2. Uploading test object...');
    const testKey = `_test-${Date.now()}.txt`;
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: testKey,
      Body: Buffer.from('test'),
      ContentType: 'text/plain',
    }));
    console.log('   OK. Uploaded:', testKey);

    console.log('3. Reading back...');
    const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: testKey }));
    const body = await obj.Body?.transformToByteArray();
    console.log('   OK. Content:', new TextDecoder().decode(body));

    console.log('\nR2 connection OK.');
  } catch (err) {
    console.error('\nERROR:', err.name, err.message);
    if (err.Code === 'AccessDenied' || err.name === 'AccessDenied') {
      console.error('\nAccess Denied usually means:');
      console.error('  - Wrong Access Key ID or Secret Access Key');
      console.error('  - Token needs "Object Read & Write" permission');
      console.error('  - Create a NEW token at: https://dash.cloudflare.com → R2 → Manage R2 API Tokens');
    }
    process.exit(1);
  }
}

test();
