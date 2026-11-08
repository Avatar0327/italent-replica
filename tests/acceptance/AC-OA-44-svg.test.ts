/**
 * R2-T08 BE-10e：AC-OA-44 纯函数部分——编制变化标记（DEC-653：“编制 3↑1”“2↓1”，箭头为图形、数字不带正负号）、
 * 名称截断、XML 转义、调整后剪掉停用分支、文件名。编制生成行随 11e / 11f，接口级只能断言无变化的“编制 {值}”或“--”，
 * 箭头渲染在这里直接喂卡片验证。
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_LAYOUT,
  type Card,
  establishmentMark,
  exportCards,
  exportFileName,
  renderSvg,
  textUnits,
  truncate,
  xmlChars,
} from '../../apps/api/src/modules/org-adjustment/export-svg.js';
import type { PreviewNode } from '../../apps/api/src/modules/org-adjustment/preview.js';

const card = (over: Partial<Card> = {}): Card => ({
  name: 'ZZ_合成组织',
  tag: null,
  head: '--',
  establishment: null,
  delta: null,
  children: [],
  ...over,
});

const previewNode = (over: Partial<PreviewNode> = {}): PreviewNode => ({
  key: over.orgId ?? over.itemId ?? 'k',
  orgId: null,
  itemId: null,
  name: null,
  personInChargeName: null,
  establishment: null,
  mark: null,
  masked: [],
  children: [],
  ...over,
});

describe('AC-OA-44 编制标记（DEC-653）', () => {
  it('增加：“编制 3↑1”；减少：“编制 2↓1”；数字不带正负号', () => {
    expect(establishmentMark(3, 1)).toEqual({ value: '3', arrow: 'up', amount: '1', label: '编制 3↑1' });
    expect(establishmentMark(2, -1)).toEqual({ value: '2', arrow: 'down', amount: '1', label: '编制 2↓1' });
  });

  it('无变化（null / 0）只显示值；没有编制为“--”且不画箭头', () => {
    expect(establishmentMark(3, null)).toEqual({ value: '3', arrow: null, amount: null, label: '编制 3' });
    expect(establishmentMark(0, 0)).toEqual({ value: '0', arrow: null, amount: null, label: '编制 0' });
    expect(establishmentMark(null, 2)).toEqual({ value: '--', arrow: null, amount: null, label: '--' });
  });

  it('SVG：上行红色、下行绿色的箭头图形，变化量是独立的 <text>；无变化时没有箭头', () => {
    const up = renderSvg([card({ establishment: 3, delta: 1 })]);
    expect(up).toMatch(/<polygon points="[^"]+" fill="#FF475A"\/>/);
    expect(up).toContain('aria-label="编制 3↑1"');
    expect(up).toMatch(/>3<\/text><polygon[^>]+\/><text[^>]*fill="#FF475A">1<\/text>/);
    const down = renderSvg([card({ establishment: 2, delta: -1 })]);
    expect(down).toMatch(/<polygon points="[^"]+" fill="#00AD0E"\/>/);
    expect(down).toMatch(/>2<\/text><polygon[^>]+\/><text[^>]*fill="#00AD0E">1<\/text>/);
    expect(renderSvg([card({ establishment: 3 })])).not.toContain('<polygon');
  });
});

describe('AC-OA-44 名称截断与转义', () => {
  it('超宽截断为“…”结尾，未超宽原样；汉字记 1、ASCII 记 0.6', () => {
    expect(textUnits('组织ab')).toBeCloseTo(3.2);
    expect(truncate('一二三四五', 5)).toBe('一二三四五');
    expect(truncate('一二三四五六', 5)).toBe('一二三四…');
    const svg = renderSvg([card({ name: `ZZ_${'很长的组织名称'.repeat(5)}` })]);
    expect(svg).toMatch(/>ZZ_很长的组织名称[^<]*…<\/text>/);
    expect(svg).not.toContain('很长的组织名称'.repeat(5));
  });

  it('名称与负责人按文本转义，不成为标签或属性', () => {
    const svg = renderSvg([card({ name: `<script>&"'`, head: '<b>x</b>' })]);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;script&gt;&amp;&quot;&#39;');
  });

  it('XML 1.0 不允许的码点（C0 控制符、U+FFFE / U+FFFF、孤立代理项）滤掉；TAB / LF / CR 与成对代理项保留', () => {
    const raw = `A\u0000\u0008\u000B\u000C\u000E\u001FB\uFFFE\uFFFF\uD800C\uDC00\t\n\r😀`;
    expect(xmlChars(raw)).toBe('ABC\t\n\r😀');
    const svg = renderSvg([card({ name: raw, head: `X\u0001Y` })]);
    expect(svg).toContain('>ABC');
    expect(svg).toContain('>XY<');
    expect(xmlChars(svg)).toBe(svg);
    expect(exportFileName([`ZZ_甲\u0001乙`], '2026-10-02')).toBe('架构图（ZZ_甲乙）_20261002');
  });
});

describe('AC-OA-44 F-446 截断按字形簇；文字不越出节点边界', () => {
  const clusters = (text: string) =>
    [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);

  it('ZWJ 组合表情整体保留或整体截掉，不在簇中间截断', () => {
    const family = '👨\u200D👩\u200D👧\u200D👦';
    const out = truncate(family.repeat(8), 5);
    const body = out.slice(0, -1);
    expect(out.endsWith('…')).toBe(true);
    expect(body).not.toBe('');
    expect(clusters(body).every((part) => part === family)).toBe(true);
  });

  it('基字与组合记号不被拆开（簇宽按基字计，不累加记号）', () => {
    const accented = 'e\u0301';
    const out = truncate(accented.repeat(30), 4.5);
    const body = out.slice(0, -1);
    expect(out.endsWith('…')).toBe(true);
    expect(body).not.toBe('');
    expect(clusters(body).every((part) => part === accented)).toBe(true);
    expect(textUnits(accented.repeat(5))).toBeCloseTo(3);
  });

  /** 节点内每个 <text> 的估算右边界（起点 + 估算宽度 × 字号）；居中的状态标签按两侧各半宽。 */
  function extents(svg: string): { text: string; right: number; left: number; anchor: boolean }[] {
    const unescape = (value: string) =>
      value
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');
    return [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+"([^>]*)>([^<]*)<\/text>/g)].map((m) => {
      const size = Number(/font-size="(\d+)"/.exec(m[2]!)?.[1] ?? 12);
      const text = unescape(m[3]!);
      const width = textUnits(text) * size;
      const middle = m[2]!.includes('text-anchor="middle"');
      const x = Number(m[1]);
      return { text, left: middle ? x - width / 2 : x, right: middle ? x + width / 2 : x + width, anchor: middle };
    });
  }

  it('满宽名称 / 负责人 / 大编制数：每段文字的估算右边界不超过节点宽度，带标签时名称不压住标签', () => {
    const wide = '宽'.repeat(40);
    const svg = renderSvg([
      card({ name: wide, tag: '变更', head: wide, establishment: 2147483648, delta: 2147483647 }),
      card({ name: wide, head: wide, establishment: 2147483648, delta: -2147483647 }),
    ]);
    const nodes = svg.split('<g class="org-node"').slice(1);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      for (const item of extents(node)) {
        expect(item.right, item.text).toBeLessThanOrEqual(260 - 8);
        expect(item.left, item.text).toBeGreaterThanOrEqual(8);
      }
    }
    const tagged = extents(nodes[0]!);
    const name = tagged.find((item) => item.text.startsWith('宽') && item.left === 36)!;
    const tag = tagged.find((item) => item.anchor)!;
    expect(name.right).toBeLessThanOrEqual(tag.left);
  });
});

describe('AC-OA-44 两态与版式', () => {
  const tree = [
    previewNode({
      orgId: 'root',
      name: 'ZZ_根',
      children: [
        previewNode({
          orgId: 'stop',
          name: 'ZZ_停',
          mark: 'deactivated',
          establishment: 4,
          children: [previewNode({ orgId: 'under', name: 'ZZ_下级' })],
        }),
        previewNode({ itemId: 'new', name: 'ZZ_新', mark: 'added' }),
        previewNode({ orgId: 'hidden', name: null, mark: null, masked: ['name'] }),
      ],
    }),
  ];

  it('调整前保留停用分支并带标签；调整后剪掉停用分支、去掉全部状态标签；看不到的名称为“--”', () => {
    const before = exportCards(tree, false);
    expect(before[0]!.children.map((c) => [c.name, c.tag])).toEqual([
      ['ZZ_停', '停用'],
      ['ZZ_新', '新增'],
      ['--', null],
    ]);
    expect(before[0]!.children[0]).toMatchObject({ establishment: 4, delta: null, children: [{ name: 'ZZ_下级' }] });
    const after = exportCards(tree, true);
    expect(after[0]!.children.map((c) => [c.name, c.tag])).toEqual([
      ['ZZ_新', null],
      ['--', null],
    ]);
    expect(JSON.stringify(after)).not.toContain('ZZ_下级');
  });

  it('SVG 尺寸包住整图：每个节点都落在 viewBox 内；多根并列', () => {
    const svg = renderSvg([...exportCards(tree, false), card({ name: 'ZZ_第二根' })]);
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.map(Number);
    const boxes = [...svg.matchAll(/<g class="org-node" transform="translate\(([\d.]+) ([\d.]+)\)">/g)];
    expect(boxes).toHaveLength(6);
    for (const [, x, y] of boxes) {
      expect(Number(x) + 260).toBeLessThanOrEqual(width!);
      expect(Number(y) + 116).toBeLessThanOrEqual(height!);
    }
    expect(renderSvg([])).toMatch(/^<svg [^>]*width="\d+" height="\d+"/);
  });

  it('文件名：多个组织以“、”连接、日期去横线；没有可见组织名时为“--”', () => {
    expect(exportFileName(['ZZ_甲', 'ZZ_乙'], '2026-10-02')).toBe('架构图（ZZ_甲、ZZ_乙）_20261002');
    expect(exportFileName([], '2026-10-02')).toBe('架构图（--）_20261002');
  });
});

describe('AC-OA-44 F-446 截断：各类字形簇、恰好等于上限、超过上限一个簇', () => {
  const segment = (text: string) =>
    [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);

  /** [说明, 一个字形簇, 单簇估算宽度, 上限, 恰好等于上限的簇数, 超过一个簇时保留的簇数] */
  const KINDS: readonly (readonly [string, string, number, number, number, number])[] = [
    ['组合记号', 'e\u0301', 0.6, 3, 5, 3],
    ['ZWJ 序列', '👨\u200D👩\u200D👧\u200D👦', 1, 5, 5, 4],
    ['变体选择符', '❤\uFE0F', 0.6, 3, 5, 3],
    ['国旗（区域指示符成对）', '🇨🇳', 1, 5, 5, 4],
    ['肤色修饰符', '👍🏽', 1, 5, 5, 4],
    ['汉字', '组', 1, 5, 5, 4],
  ];

  for (const [kind, unit, width, max, exact, kept] of KINDS) {
    it(`${kind}：恰好等于上限不加“…”；多一个簇以“…”结尾，保留整簇，不在簇中间截断`, () => {
      expect(segment(unit)).toHaveLength(1);
      expect(textUnits(unit.repeat(exact))).toBeCloseTo(max);
      const same = truncate(unit.repeat(exact), max);
      expect(same).toBe(unit.repeat(exact));
      expect(same.endsWith('…')).toBe(false);

      const over = truncate(unit.repeat(exact + 1), max);
      expect(over).toBe(`${unit.repeat(kept)}…`);
      expect(segment(over.slice(0, -1))).toEqual(Array.from({ length: kept }, () => unit));
      // “…”记 1：截断结果不超过上限
      expect(textUnits(over)).toBeLessThanOrEqual(max);
      expect(width * kept + 1).toBeLessThanOrEqual(max);
    });
  }

  it('首个字形簇就放不下时只剩“…”', () => {
    expect(truncate('👨\u200D👩\u200D👧\u200D👦👨\u200D👩', 1)).toBe('…');
  });

  it('CJK 与拉丁混排：记 1 / 0.6；恰好等于上限不截断，多一个字符就截断且不拆汉字 / 簇', () => {
    const exact = `${'一'.repeat(12)}${'a'.repeat(5)}`; // 12 + 3 = 15
    expect(textUnits(exact)).toBeCloseTo(15);
    expect(truncate(exact, 15)).toBe(exact);
    expect(truncate(`${exact}b`, 15)).toMatch(/…$/);
    expect(truncate('组织ab组织ab组织ab', 5)).toBe('组织ab…');
    const mixed = truncate(`ab${'👨\u200D👩'.repeat(10)}cd`, 5);
    expect(mixed.startsWith('ab')).toBe(true);
    expect(segment(mixed.slice(2, -1)).every((part) => part === '👨\u200D👩')).toBe(true);
  });

  it('SVG 输出的是截断后的文字：名称（带 / 不带标签）与负责人各按自己的上限', () => {
    const family = '👨\u200D👩\u200D👧\u200D👦';
    const texts = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]!);
    const plain = renderSvg([card({ name: family.repeat(30), head: '🇨🇳'.repeat(30) })]);
    expect(texts(plain)[0]).toBe(truncate(family.repeat(30), CARD_LAYOUT.nameUnits));
    expect(texts(plain)).toContain(truncate('🇨🇳'.repeat(30), CARD_LAYOUT.valueUnits));
    expect(plain).not.toContain(family.repeat(30));
    const tagged = renderSvg([card({ name: family.repeat(30), tag: '新增' })]);
    expect(texts(tagged)[0]).toBe(truncate(family.repeat(30), CARD_LAYOUT.taggedNameUnits));
    expect(texts(tagged)[0]!.length).toBeLessThan(texts(plain)[0]!.length);
  });
});

describe('AC-OA-44 F-446 文字不越出卡片：按 NAME_UNITS / TAGGED_NAME_UNITS / VALUE_UNITS 估算', () => {
  const { width, nameUnits, taggedNameUnits, valueX, valueUnits, font } = CARD_LAYOUT;
  const PADDING = 8;
  const NAME_X = 36;
  const NAME_FONT = 14;
  const TAG_PILL_LEFT = width - 52;

  it('上限常量本身自洽：满上限的名称 / 数值文字落在卡片内，带标签的名称不压住标签', () => {
    expect(NAME_X + nameUnits * NAME_FONT).toBeLessThanOrEqual(width - PADDING);
    expect(NAME_X + taggedNameUnits * NAME_FONT).toBeLessThanOrEqual(TAG_PILL_LEFT);
    expect(valueX + valueUnits * font).toBeLessThanOrEqual(width - PADDING);
  });

  const MAX_NAME = (tagged: boolean) => (tagged ? taggedNameUnits : nameUnits);
  const SAMPLES: readonly (readonly [string, (units: number) => string])[] = [
    ['汉字', (units) => '宽'.repeat(units)],
    ['拉丁', (units) => 'a'.repeat(Math.floor(units / 0.6))],
    ['汉字拉丁混排', (units) => `${'宽'.repeat(Math.floor(units / 2))}${'a'.repeat(Math.floor(units / 2 / 0.6))}`],
    ['ZWJ 表情', (units) => '👨\u200D👩\u200D👧\u200D👦'.repeat(units)],
    ['国旗', (units) => '🇨🇳'.repeat(units)],
  ];

  for (const tagged of [false, true]) {
    for (const [kind, make] of SAMPLES) {
      for (const over of [false, true]) {
        const label = `${tagged ? '带标签' : '不带标签'}·${kind}·${over ? '超过上限' : '不超过上限'}`;
        it(`${label}：名称、负责人、数值的估算右边界不越出卡片`, () => {
          const name = make(MAX_NAME(tagged) + (over ? 10 : 0));
          const head = make(valueUnits + (over ? 10 : 0));
          const svg = renderSvg([card({ name, head, tag: tagged ? '变更' : null, establishment: 99 })]);
          const items = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+"([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
            x: Number(m[1]),
            size: Number(/font-size="(\d+)"/.exec(m[2]!)?.[1] ?? font),
            middle: m[2]!.includes('text-anchor="middle"'),
            text: m[3]!,
          }));
          const nameItem = items[0]!;
          const nameRight = nameItem.x + textUnits(nameItem.text) * nameItem.size;
          expect(nameRight, nameItem.text).toBeLessThanOrEqual(tagged ? TAG_PILL_LEFT : width - PADDING);
          const headItem = items.find((item) => item.x === valueX && item.text !== '99' && item.text !== '--')!;
          expect(headItem.x + textUnits(headItem.text) * headItem.size).toBeLessThanOrEqual(width - PADDING);
          for (const item of items) {
            const half = item.middle ? (textUnits(item.text) * item.size) / 2 : 0;
            expect(item.x - half).toBeGreaterThanOrEqual(PADDING);
            expect(item.x + (item.middle ? half : textUnits(item.text) * item.size)).toBeLessThanOrEqual(
              width - PADDING,
            );
          }
          if (over) {
            expect(nameItem.text.endsWith('…')).toBe(true);
            expect(headItem.text.endsWith('…')).toBe(true);
          } else {
            expect(nameItem.text.endsWith('…')).toBe(false);
          }
        });
      }
    }
  }
});
