/**
 * 读 TrueType 字体的 cmap（Unicode → 字形），测试用：断言内置中文字体子集覆盖了哪些字符（F-080）。
 * 只支持 format 4（BMP）与 format 12（全平面）两种子表，足够覆盖思源黑体子集。
 */
import { readFileSync } from 'node:fs';

export function cmapCodepoints(file: string): Set<number> {
  const buffer = readFileSync(file);
  const tables = buffer.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    if (buffer.toString('latin1', record, record + 4) === 'cmap') cmap = buffer.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error(`${file} 没有 cmap 表`);
  const codepoints = new Set<number>();
  const subtables = buffer.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i += 1) {
    const start = cmap + buffer.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = buffer.readUInt16BE(start);
    if (format === 4) {
      const segments = buffer.readUInt16BE(start + 6) / 2;
      const ends = start + 14;
      const starts = ends + segments * 2 + 2;
      for (let s = 0; s < segments; s += 1) {
        const last = buffer.readUInt16BE(ends + s * 2);
        for (let c = buffer.readUInt16BE(starts + s * 2); c <= last && c !== 0xffff; c += 1) codepoints.add(c);
      }
    } else if (format === 12) {
      const groups = buffer.readUInt32BE(start + 12);
      for (let g = 0; g < groups; g += 1) {
        const at = start + 16 + g * 12;
        for (let c = buffer.readUInt32BE(at); c <= buffer.readUInt32BE(at + 4); c += 1) codepoints.add(c);
      }
    }
  }
  return codepoints;
}
