/** AC-TC（补）F-038 R2-P2-3：有签名的空壳不等于能解码的图片，拒绝后保留当前图。 */
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { talentWorld, type TalentWorld } from './AC-TC-support.js';
import {
  attachmentStatus,
  contentPath,
  expectImageError,
  fixtureFromBytes,
  imageFixture,
  modelPath,
  readModel,
  registerImage,
  uploadImage,
} from './AC-TC-model-image-support.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function falsePng(pixels: Buffer) {
  const valid = imageFixture().bytes;
  return fixtureFromBytes(
    Buffer.concat([valid.subarray(0, 33), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]),
  );
}

function emptyGif() {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
  const image = Buffer.from('2c00000000010001000002003b', 'hex');
  return fixtureFromBytes(Buffer.concat([header, image]), 'gif');
}

function gifWithOnlyControlCodes() {
  const bytes = emptyGif().bytes;
  return fixtureFromBytes(Buffer.concat([bytes.subarray(0, -2), Buffer.from([1, 0x2c, 0, 0x3b])]), 'gif');
}

function incompleteGifFrame() {
  const bytes = Buffer.from(imageFixture('gif').bytes);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(2, bytes.indexOf(0x2c) + 7);
  return fixtureFromBytes(bytes, 'gif');
}

function emptyJpeg() {
  return fixtureFromBytes(Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f00ffd9', 'hex'), 'jpeg');
}

function missingJpegScan() {
  const valid = imageFixture('jpeg').bytes;
  const start = valid.indexOf(Buffer.from([0xff, 0xda]));
  const end = start + 2 + valid.readUInt16BE(start + 2);
  return fixtureFromBytes(Buffer.concat([valid.subarray(0, end), Buffer.from([0xff, 0xd9])]), 'jpg');
}

function fakeJpegScan(byte: number) {
  const bytes = missingJpegScan().bytes;
  return fixtureFromBytes(Buffer.concat([bytes.subarray(0, -2), Buffer.from([byte]), bytes.subarray(-2)]), 'jpg');
}

function zeroDepthBmp() {
  const bytes = Buffer.from(imageFixture('bmp').bytes);
  bytes.writeUInt16LE(0, 28);
  return fixtureFromBytes(bytes, 'bmp');
}

const testDb = useTestDb();
describe('AC-TC（补）F-038 R2 实际像素解码', () => {
  let world: TalentWorld;
  let categoryId: string;
  beforeAll(async () => {
    world = await talentWorld(testDb().db, 'model-image-decode');
    categoryId = (await world.category()).id;
  });

  it.each([
    ['IDAT 装文本但 CRC 正确的 PNG', () => falsePng(Buffer.from('synthetic text is not compressed pixels'))],
    ['能 inflate 但没有像素行的 PNG', () => falsePng(deflateSync(Buffer.alloc(0)))],
    ['没有 LZW 像素的 GIF', emptyGif],
    ['只有 clear/end 码但没有像素的 GIF', gifWithOnlyControlCodes],
    ['帧需要两个像素但码流只提供一个的 GIF', incompleteGifFrame],
    ['没有扫描数据的 JPEG 空壳', emptyJpeg],
    ['保留量化与霍夫曼表但无扫描像素的 JPG', missingJpegScan],
    ['扫描区只有单个 00 字节的 JPG', () => fakeJpegScan(0)],
    ['扫描区只有单个 7F 字节的 JPG', () => fakeJpegScan(0x7f)],
    ['位深为 0 的 BMP', zeroDepthBmp],
  ] as const)('%s 返回 415，当前图、revision 与附件状态不变', async (_label, makeInvalid) => {
    const parent = await world.criterion(categoryId, [], { name: `合成解码标准 ${randomUUID()}` });
    const valid = imageFixture();
    const first = await registerImage(world.request, parent.id, parent.revision, valid);
    const current = await uploadImage(world.request, parent.id, first, valid);
    const invalid = makeInvalid();
    const registered = await registerImage(world.request, parent.id, current.revision, invalid);
    const before = await readModel(world.request, parent.id);

    await expectImageError(
      await world.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: invalid.base64 },
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );

    expect(await readModel(world.request, parent.id)).toEqual(before);
    expect(await attachmentStatus(testDb().db, world.tenant.id, first.attachment.id)).toBe('uploaded');
    expect(await attachmentStatus(testDb().db, world.tenant.id, registered.attachment.id)).toBe('registered');
    const response = await world.request('GET', contentPath(parent.id, first.attachment.id));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(valid.bytes);
    await expectImageError(
      await world.request('GET', contentPath(parent.id, registered.attachment.id)),
      404,
      'NOT_FOUND',
    );
  });
});
