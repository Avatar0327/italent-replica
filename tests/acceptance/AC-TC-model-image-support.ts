/** F-038 潜力模型图：合成静态图片与 HTTP 夹具，无原站素材或真实个人数据。 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { sql, type Db, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { RequestOptions } from './support/tenant-api.js';

export const MODEL_IMAGE_LIMIT = 5 * 1024 * 1024;
export const MODEL_IMAGE_AUDIT_TYPE = 'TalentCenter.TalentCriterionModelImage';
export type ImageExtension = 'jpeg' | 'jpg' | 'gif' | 'png' | 'bmp';
export type ImageRequest = (method: string, path: string, options?: RequestOptions) => Promise<Response>;

export interface ImageMetadata {
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ImageFixture {
  readonly bytes: Buffer;
  readonly base64: string;
  readonly metadata: ImageMetadata;
}

export interface ModelImage extends ImageMetadata {
  readonly id: string;
}

export interface ModelImageView {
  readonly revision: number;
  readonly canEdit?: boolean;
  readonly modelImage: ModelImage | null;
}

export interface RegisteredImage {
  readonly revision: number;
  readonly attachment: ModelImage & { readonly status: 'registered' };
}

// 作者在本机用合成 1px BMP 转出的 JPEG；运行验收时无需图片转换工具。
const JPEG = Buffer.from(
  [
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC',
    'AAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ',
    'jwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB',
    'AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE',
    'RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI',
    'ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB',
    'AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD',
    'REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG',
    'x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgK',
    'CgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
    'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+c6KKK/og/Bz/9k=',
  ].join(''),
  'base64',
);

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

/** 用合法 ancillary tEXt chunk 凑精确文件大小，不靠无效尾部填充测试 5 MiB 边界。 */
export function pngBytes(size?: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 51, 102, 153, 255])))];
  const end = pngChunk('IEND', Buffer.alloc(0));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const plainSize = signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0) + end.length;
  if (size !== undefined) {
    const text = Buffer.alloc(size - plainSize - 12, 120);
    Buffer.from('Padding\0').copy(text);
    chunks.push(pngChunk('tEXt', text));
  }
  return Buffer.concat([signature, ...chunks, end]);
}

function bmpBytes(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(4, 34);
  Buffer.from([153, 102, 51, 0]).copy(bytes, 54);
  return bytes;
}

export function fixtureFromBytes(bytes: Buffer, extension: ImageExtension = 'png'): ImageFixture {
  const contentType = extension === 'jpeg' || extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  return {
    bytes,
    base64: bytes.toString('base64'),
    metadata: {
      filename: `potential-model.${extension}`,
      contentType,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

export function imageFixture(extension: ImageExtension = 'png'): ImageFixture {
  const bytes = extension === 'png' ? pngBytes() : extension === 'gif' ? GIF : extension === 'bmp' ? bmpBytes() : JPEG;
  return fixtureFromBytes(bytes, extension);
}

export function animatedGif(): ImageFixture {
  const frameStart = GIF.indexOf(0x2c);
  return fixtureFromBytes(Buffer.concat([GIF.subarray(0, -1), GIF.subarray(frameStart)]), 'gif');
}

export function animatedPng(): ImageFixture {
  const png = pngBytes();
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  return fixtureFromBytes(Buffer.concat([png.subarray(0, 33), pngChunk('acTL', animation), png.subarray(33)]));
}

export const modelPath = (criterionId: string) => `/criteria/${criterionId}/model-image`;
export const contentPath = (criterionId: string, attachmentId: string) =>
  `${modelPath(criterionId)}/attachments/${attachmentId}/content`;

export async function expectImageError(response: Response, status: number, code: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect((await response.json()) as unknown).toMatchObject({ error: { code } });
}

export async function readModel(request: ImageRequest, criterionId: string): Promise<ModelImageView> {
  const response = await request('GET', modelPath(criterionId));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ModelImageView;
}

export async function registerImage(
  request: ImageRequest,
  criterionId: string,
  revision: number,
  fixture = imageFixture(),
  commandId?: string,
): Promise<RegisteredImage> {
  const response = await request('POST', `${modelPath(criterionId)}/attachments`, {
    ifMatch: revision,
    body: fixture.metadata,
    idempotencyKey: commandId,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as RegisteredImage;
  expect(body).toEqual({
    revision: revision + 1,
    attachment: { id: expect.any(String), ...fixture.metadata, status: 'registered' },
  });
  return body;
}

export async function uploadImage(
  request: ImageRequest,
  criterionId: string,
  registered: RegisteredImage,
  fixture = imageFixture(),
  commandId?: string,
): Promise<ModelImageView> {
  const response = await request('POST', `${modelPath(criterionId)}/attachments/${registered.attachment.id}/upload`, {
    ifMatch: registered.revision,
    body: { base64: fixture.base64 },
    idempotencyKey: commandId,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as ModelImageView;
  expect(body).toMatchObject({
    revision: registered.revision + 1,
    modelImage: { id: registered.attachment.id, ...fixture.metadata },
  });
  expect(JSON.stringify(body)).not.toContain(fixture.base64);
  return body;
}

export async function attachmentStatus(db: Db, tenantId: string, attachmentId: string): Promise<string | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT status FROM talent_model_image_attachments
      WHERE tenant_id=${tenantId} AND id=${attachmentId}::uuid`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { status: string }[] }).rows) as {
      status: string;
    }[];
    return rows[0]?.status;
  });
}
