/**
 * 读 TrueType 字体的 cmap（Unicode → 字形），测试用：断言内置中文字体子集覆盖了哪些字符（F-080）。
 * 只支持 format 4（BMP）与 format 12（全平面）两种子表，足够覆盖思源黑体子集。
 * 覆盖按 glyph ID 判断：码点映射到 glyph 0（.notdef，缺字方框）等于没有字形，不算覆盖（#198 审查 P3）。
 */
import { readFileSync } from 'node:fs';

function format4(buffer: Buffer, start: number, covered: Set<number>): void {
  const segments = buffer.readUInt16BE(start + 6) / 2;
  const ends = start + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  for (let s = 0; s < segments; s += 1) {
    const first = buffer.readUInt16BE(starts + s * 2);
    const last = buffer.readUInt16BE(ends + s * 2);
    const delta = buffer.readUInt16BE(deltas + s * 2);
    const rangeOffset = buffer.readUInt16BE(offsets + s * 2);
    for (let c = first; c <= last && c !== 0xffff; c += 1) {
      let glyph = (c + delta) & 0xffff;
      if (rangeOffset !== 0) {
        const raw = buffer.readUInt16BE(offsets + s * 2 + rangeOffset + (c - first) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(c);
    }
  }
}

function format12(buffer: Buffer, start: number, covered: Set<number>): void {
  const groups = buffer.readUInt32BE(start + 12);
  for (let g = 0; g < groups; g += 1) {
    const at = start + 16 + g * 12;
    const first = buffer.readUInt32BE(at);
    const glyph = buffer.readUInt32BE(at + 8);
    for (let c = first; c <= buffer.readUInt32BE(at + 4); c += 1) if (glyph + (c - first) !== 0) covered.add(c);
  }
}

/** 字体里有真实字形（glyph ID ≠ 0）的码点集合。 */
export function cmapOfBuffer(buffer: Buffer): Set<number> {
  const tables = buffer.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    if (buffer.toString('latin1', record, record + 4) === 'cmap') cmap = buffer.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error('字体没有 cmap 表');
  const covered = new Set<number>();
  const subtables = buffer.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i += 1) {
    const start = cmap + buffer.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = buffer.readUInt16BE(start);
    if (format === 4) format4(buffer, start, covered);
    else if (format === 12) format12(buffer, start, covered);
  }
  return covered;
}

export const cmapCodepoints = (file: string): Set<number> => cmapOfBuffer(readFileSync(file));
