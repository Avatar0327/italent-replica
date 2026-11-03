/**
 * R2-T08 BE-10e：AC-OA-44 纯函数部分——编制变化标记（DEC-653：“编制 3↑1”“2↓1”，箭头为图形、数字不带正负号）、
 * 名称截断、XML 转义、调整后剪掉停用分支、文件名。编制生成行随 11e / 11f，接口级只能断言无变化的“编制 {值}”或“--”，
 * 箭头渲染在这里直接喂卡片验证。
 */
import { describe, expect, it } from 'vitest';
import {
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
