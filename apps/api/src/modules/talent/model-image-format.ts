/** Q-M0-126：五种文件扩展名、单张静态图片、5M 内；类型同时核对声明与文件结构。 */
import { AppError } from '../../errors.js';

export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MODEL_IMAGE_BODY_LIMIT = 4 * Math.ceil(MODEL_IMAGE_MAX_BYTES / 3) + 1024;
const MIME: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  bmp: 'image/bmp',
};

export interface ImageMetadata {
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export function validateImageMetadata(input: ImageMetadata): void {
  if (input.byteSize > MODEL_IMAGE_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '模型图不能超过 5M');
  }
  if (input.byteSize <= 0) throw new AppError('VALIDATION_FAILED', '模型图不能为空');
  const extension = input.filename.split('.').at(-1)?.toLowerCase() ?? '';
  if (!MIME[extension] || MIME[extension] !== input.contentType) unsupported();
}

export function decodeImage(base64: string): Buffer {
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new AppError('VALIDATION_FAILED', '图片内容必须为有效 base64');
  }
  if (base64.length > 4 * Math.ceil(MODEL_IMAGE_MAX_BYTES / 3)) {
    throw new AppError('PAYLOAD_TOO_LARGE', '模型图不能超过 5M');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== base64) {
    throw new AppError('VALIDATION_FAILED', '图片内容必须为有效 base64');
  }
  if (bytes.length > MODEL_IMAGE_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', '模型图不能超过 5M');
  return bytes;
}

export function validateImageContent(bytes: Buffer, contentType: string): void {
  const valid =
    contentType === 'image/png'
      ? staticPng(bytes)
      : contentType === 'image/gif'
        ? staticGif(bytes)
        : contentType === 'image/jpeg'
          ? jpeg(bytes)
          : contentType === 'image/bmp' && bmp(bytes);
  if (!valid) unsupported();
}

function unsupported(): never {
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg、jpg、gif、png、bmp 格式的静态图片');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function staticPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  let header = false;
  let pixels = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false;
    if (!header) {
      if (type !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) {
        return false;
      }
      header = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') pixels = true;
    if (type === 'IEND') return size === 0 && pixels && end === bytes.length;
    offset = end;
  }
  return false;
}

/** GIF 以块边界计数帧，不能在压缩内容中搜索 0x2c（会把像素数据误认成第二帧）。 */
function staticGif(bytes: Buffer): boolean {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return false;
  if (!bytes.readUInt16LE(6) || !bytes.readUInt16LE(8)) return false;
  let offset = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames === 1 && offset === bytes.length;
    if (marker === 0x21) {
      offset += 1;
    } else if (marker === 0x2c) {
      frames += 1;
      if (frames > 1 || offset + 9 > bytes.length) return false;
      if (!bytes.readUInt16LE(offset + 4) || !bytes.readUInt16LE(offset + 6)) return false;
      const packed = bytes[offset + 8]!;
      offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) return false;
      offset += 1;
    } else return false;
    offset = skipGifBlocks(bytes, offset);
    if (offset < 0) return false;
  }
  return false;
}

function skipGifBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset++]!;
    if (!size) return offset;
    offset += size;
  }
  return -1;
}

function jpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) {
      if (!scan) return false;
      else continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (scan && (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7))) continue;
    if (marker === undefined || marker === 0xd8 || offset + 2 > bytes.length) return false;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return false;
      frame = true;
    }
    if (marker === 0xda) scan = true;
    offset += size;
  }
  return false;
}

function bmp(bytes: Buffer): boolean {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM' || bytes.readUInt32LE(2) !== bytes.length)
    return false;
  const header = bytes.readUInt32LE(14);
  const pixels = bytes.readUInt32LE(10);
  if (pixels < 14 + header || pixels >= bytes.length) return false;
  if (header === 12) return !!bytes.readUInt16LE(18) && !!bytes.readUInt16LE(20) && bytes.readUInt16LE(22) === 1;
  return (
    header >= 40 &&
    bytes.length >= 54 &&
    !!bytes.readInt32LE(18) &&
    !!bytes.readInt32LE(22) &&
    bytes.readUInt16LE(26) === 1
  );
}
