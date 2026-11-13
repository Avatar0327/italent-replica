/** F-474-8b §3.1 / §6：固定来源、父级优先切片与来源缺损拒绝。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRegions, seedBlock, verifySource } from '../../scripts/admin-regions.mjs';

const html = (entries: string[][]) =>
  `<table>${entries.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const entries = [
  ['130102', '合成区'],
  ['130100', '合成市'],
  ['130000', '合成省'],
];

describe('AC-F474-8c0 来源生成与校验工具', () => {
  it('AC-F474-8c0-06 从表格读取代码和名字，按省市县及代码排序', () => {
    expect(parseRegions(html(entries))).toEqual([
      { code: '130000', parentCode: null, level: 1, name: '合成省' },
      { code: '130100', parentCode: '130000', level: 2, name: '合成市' },
      { code: '130102', parentCode: '130100', level: 3, name: '合成区' },
    ]);
  });

  it('AC-F474-8c0-07 直辖市区县、省直辖县按来源归省级，星号为脚注', () => {
    const result = parseRegions(
      html([
        ...entries,
        ['110000', '北京市'],
        ['110108', '<span>海淀区</span>'],
        ['410000', '河南省'],
        ['419001', '济源市*'],
      ]),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        { code: '110108', parentCode: '110000', level: 3, name: '海淀区' },
        { code: '419001', parentCode: '410000', level: 3, name: '济源市' },
      ]),
    );
    expect(result.some((r) => ['110100', '419000'].includes(r.code))).toBe(false);
  });

  it.each([
    [[], /层级/],
    [[entries[0]!, entries[1]!], /父级/],
    [[entries[0]!, entries[2]!, ['140100', '合成市']], /父级/],
    [[entries[1]!, entries[2]!], /层级/],
    [[...entries, entries[0]!], /重复/],
    [[...entries, ['139001', '无来源标记的直辖县']], /父级/],
  ])('AC-F474-8c0-08 缺层级、父级或重复代码时拒绝生成', (fixture, message) => {
    expect(() => parseRegions(html(fixture))).toThrow(message);
  });

  it('AC-F474-8c0-09 N 超过 4000 时停止', () => {
    const oversized = Array.from({ length: 4001 }, (_, i) => [String(100000 + i), '合成区划']);
    expect(() => parseRegions(html(oversized))).toThrow(/4000/);
  });

  it('AC-F474-8c0-10 来源字节不匹配固定 SHA-256 时拒绝', () => {
    expect(() => verifySource(Buffer.from(html(entries)))).toThrow(/SHA-256/);
  });

  it('AC-F474-8c0-11 每条独立一行，SQL 引号转义，第二片可引用首片父级', () => {
    const data = parseRegions(html([...entries, ['130103', "合成'区"]]));
    expect(seedBlock(data, 1, 3)).toContain("('130102', '130100', 3, '合成区');");
    expect(seedBlock(data, 2, 3)).toContain("('130103', '130100', 3, '合成''区');");
    expect(
      seedBlock(data, 1, 3)
        .split('\n')
        .filter((line) => line.startsWith('(')),
    ).toHaveLength(3);
    expect(() => seedBlock(data, 1, 2001)).toThrow(/2000/);
  });

  it('AC-F474-8c0-12 来源说明固定四项及总数，明确存档与官方发布范围', () => {
    const source = JSON.parse(
      readFileSync(new URL('../../scripts/admin-regions-source.json', import.meta.url), 'utf8'),
    );
    expect(source).toMatchObject({
      version: '2023',
      originalUrl: 'https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html',
      archiveUrl: 'https://web.archive.org/web/20250730184306/https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html',
      sha256: '4909c8bc2384429a5da76c954c13bc3c7dec4bf2153b4a6dabaf0d1ce332771f',
      total: 3209,
      levels: [34, 333, 2842],
      sliceSize: 1900,
    });
    expect(source.note).toContain('取自存档副本');
    expect(source.coverage).toContain('台湾省、香港特别行政区和澳门特别行政区暂缺地市和区县信息');
  });
});
