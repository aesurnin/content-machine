import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'https';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    const bucket = process.env.R2_BUCKET_NAME;
    const endpoint = process.env.R2_ENDPOINT;
    if (!bucket || !endpoint) {
      throw new Error('R2_BUCKET_NAME and R2_ENDPOINT must be set');
    }
    const httpsAgent = new https.Agent({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      keepAlive: false,
    });
    client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({ httpsAgent }),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

function getBucket(): string {
  return process.env.R2_BUCKET_NAME!;
}

export function isR2Configured(): boolean {
  return !!(
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

export async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType?: string
): Promise<void> {
  const ct = contentType ?? 'video/mp4';
  const s3 = getClient();
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: buffer,
    ContentType: ct,
  });
  
  try {
    await s3.send(command);
  } catch (err) {
    console.error(`[R2] Upload failed: ${err}`);
    throw err;
  }
}

export async function deleteFromR2(key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );
}

/** Delete multiple R2 objects in batch (up to 1000 per S3 API call). */
export async function deleteMultipleFromR2(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const s3 = getClient();
  const batchSize = 1000;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
}

export async function deletePrefixFromR2(prefix: string): Promise<void> {
  const s3 = getClient();
  let continuationToken: string | undefined;
  do {
    const listRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: getBucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const keys = (listRes.Contents ?? []).map((c) => c.Key).filter((k): k is string => !!k);
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: getBucket(),
          Delete: {
            Objects: keys.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);
}

export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
  const s3 = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getObjectFromR2(key: string): Promise<Buffer> {
  const s3 = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });
  const res = await s3.send(command);
  const body = res.Body;
  if (!body) throw new Error(`Empty object: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type StreamObjectResult = {
  body: AsyncIterable<Uint8Array>;
  contentLength: number;
  contentType: string;
  contentRange?: string;
  statusCode: 200 | 206;
};

export async function streamObjectFromR2(
  key: string,
  range?: string
): Promise<StreamObjectResult> {
  const s3 = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ...(range && { Range: range }),
  });
  const res = await s3.send(command);
  const body = res.Body;
  if (!body) throw new Error(`Empty object: ${key}`);
  const contentLength = res.ContentLength ?? 0;
  const contentType = (res.ContentType as string) || inferContentType(key);
  const contentRange = res.ContentRange as string | undefined;
  const statusCode = range && contentRange ? 206 : 200;
  return {
    body: body as AsyncIterable<Uint8Array>,
    contentLength,
    contentType,
    contentRange,
    statusCode,
  };
}

export async function listObjectsFromR2(prefix: string): Promise<string[]> {
  const s3 = getClient();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: getBucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

export type R2ObjectMeta = {
  key: string;
  size?: number;
  lastModified?: Date;
  contentType?: string;
};

function inferContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    json: 'application/json',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  };
  return map[ext ?? ''] ?? 'application/octet-stream';
}

export async function listObjectsWithMetaFromR2(prefix: string): Promise<R2ObjectMeta[]> {
  const s3 = getClient();
  const result: R2ObjectMeta[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: getBucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      result.push({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
        contentType: inferContentType(obj.Key),
      });
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return result;
}
