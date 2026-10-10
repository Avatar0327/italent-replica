/**
 * F-080 第 1 轮 P3（PR #198 审查）：字体覆盖测试要按 glyph ID 判断，不能只枚举码点——码点映射到 glyph 0（.notdef，缺字
 * 方框）等于没有字形。用合成的最小 sfnt 给出反例：format 12 / format 4（idDelta 与 idRangeOffset 两条路径）里映射到
 * glyph 0 的码点必须判未覆盖，其余照常覆盖。
 */
import { describe, expect, it } from 'vitest';
import { cmapOfBuffer } from './support/ttf-cmap.js';

/** 只含 cmap 一张表的最小 sfnt。 */
function sfntWithCmap(cmap: Buffer): Buffer {
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write('cmap', 12, 'latin1');
  header.writeUInt32BE(28, 20);
  header.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([header, cmap]);
}

/** cmap 表头 + 一条 Unicode 编码记录，指向紧随其后的子表。 */
function cmapTable(subtable: Buffer, platform = 3, encoding = 10): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(platform, 4);
  head.writeUInt16BE(encoding, 6);
  head.writeUInt32BE(12, 8);
  return Buffer.concat([head, subtable]);
}

function format12(groups: readonly [number, number, number][]): Buffer {
  const out = Buffer.alloc(16 + groups.length * 12);
  out.writeUInt16BE(12, 0);
  out.writeUInt32BE(out.length, 4);
  out.writeUInt32BE(groups.length, 12);
  groups.forEach(([start, end, glyph], i) => {
    out.writeUInt32BE(start, 16 + i * 12);
    out.writeUInt32BE(end, 20 + i * 12);
    out.writeUInt32BE(glyph, 24 + i * 12);
  });
  return out;
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
  /** 非空时该段走 glyphIdArray（idRangeOffset ≠ 0）。 */
  readonly glyphs?: readonly number[];
}

function format4(segments: readonly Segment[]): Buffer {
  const count = segments.length + 1; // 末段 0xFFFF
  const arrays = segments.flatMap((s) => s.glyphs ?? []);
  const length = 16 + count * 8 + arrays.length * 2;
  const out = Buffer.alloc(length);
  out.writeUInt16BE(4, 0);
  out.writeUInt16BE(length, 2);
  out.writeUInt16BE(count * 2, 6);
  const ends = 14;
  const starts = ends + count * 2 + 2;
  const deltas = starts + count * 2;
  const offsets = deltas + count * 2;
  const glyphArray = offsets + count * 2;
  let used = 0;
  [...segments, { start: 0xffff, end: 0xffff, delta: 1 }].forEach((s, i) => {
    out.writeUInt16BE(s.end, ends + i * 2);
    out.writeUInt16BE(s.start, starts + i * 2);
    out.writeUInt16BE(s.delta & 0xffff, deltas + i * 2);
    if (s.glyphs) {
      out.writeUInt16BE(glyphArray + used * 2 - (offsets + i * 2), offsets + i * 2);
      s.glyphs.forEach((g, n) => out.writeUInt16BE(g, glyphArray + (used + n) * 2));
      used += s.glyphs.length;
    }
  });
  return out;
}

const covered = (cmap: Buffer, encoding = 10) => [...cmapOfBuffer(sfntWithCmap(cmapTable(cmap, 3, encoding)))].sort();

describe('AC-360-F080 R1 P3 cmap 覆盖按 glyph ID 判断', () => {
  it('format 12：映射到 glyph 0 的码点不算覆盖', () => {
    // 0x4E2D→0（.notdef）、0x4E2E→1、0x4E2F→2；0x5000..0x5001→10、11
    expect(
      covered(
        format12([
          [0x4e2d, 0x4e2f, 0],
          [0x5000, 0x5001, 10],
        ]),
      ),
    ).toEqual([0x4e2e, 0x4e2f, 0x5000, 0x5001]);
  });

  it('format 4（idDelta）：glyph = (码点 + idDelta) mod 65536，结果为 0 的不算覆盖', () => {
    // 'A'(0x41)→0、'B'→1、'C'→2
    expect(covered(format4([{ start: 0x41, end: 0x43, delta: -0x41 }]), 1)).toEqual([0x42, 0x43]);
  });

  it('format 4（idRangeOffset / glyphIdArray）：数组里是 0 的不算覆盖；非 0 项再加 idDelta', () => {
    // 0x61..0x63 → glyphIdArray [7, 0, 9]，idDelta 100：0x61→107、0x62→0（缺字）、0x63→109
    expect(covered(format4([{ start: 0x61, end: 0x63, delta: 100, glyphs: [7, 0, 9] }]), 1)).toEqual([0x61, 0x63]);
  });

  it('format 4：glyphIdArray 里的非 0 值加 idDelta 后恰好回绕到 0 时也不算覆盖', () => {
    expect(covered(format4([{ start: 0x61, end: 0x62, delta: -5, glyphs: [5, 6] }]), 1)).toEqual([0x62]);
  });
});
