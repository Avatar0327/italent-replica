/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-475 2/3 盘点 B：九宫格详细设置 / 通用设置（R3cd spec §3.2）。原站是设置整页：顶部两个页签、配置胶囊切换、
 * 四个分区与右侧锚点、比例规则表固定列宽、没有保存按钮。复刻读真实九宫格配置只读呈现，缺契约的项标未完成。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base,
  button,
  click,
  headerWidths,
  headers,
  json,
  mount,
  openTab,
  resetServer,
  server,
  squash,
  text,
  unmount,
} from './support/talent-review-f475b.js';

const MATRIX = 'TalentReview.Matrix';
const matrixFields = [
  'id',
  'revision',
  'createdBy',
  'createdAt',
  'updatedAt',
  'code',
  'name',
  'xFieldId',
  'yFieldId',
  'zFieldId',
  'xDraggable',
  'yDraggable',
  'placementSource',
  'greenRateReference',
  'preset',
  'positionFields',
  'axisLevels',
  'cells',
  'ratioGroups',
  'sortNo',
  'enabled',
];
/** 与 apps/api/src/modules/talent-review/matrix-view.ts 的 MatrixView 同形。 */
function matrix(id: string, name: string, extra: Record<string, unknown> = {}) {
  const cells = [1, 2, 3].flatMap((y) =>
    [1, 2, 3].map((x) => ({
      cellNo: (y - 1) * 3 + x,
      xLevelNo: x,
      yLevelNo: y,
      name: `合成格${(y - 1) * 3 + x}`,
      color: '#d9e7ff',
      textColor: '#1f2329',
      exportOrder: 10 - ((y - 1) * 3 + x),
      countsGreen: x + y >= 5,
    })),
  );
  return {
    id,
    code: `M_${id}`,
    name,
    xFieldId: 'f-x',
    yFieldId: 'f-y',
    zFieldId: null,
    xDraggable: true,
    yDraggable: false,
    placementSource: 'after_else_before',
    greenRateReference: true,
    preset: false,
    sortNo: 1,
    enabled: true,
    revision: 3,
    createdBy: 'u-1',
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedBy: 'u-1',
    updatedAt: '2026-10-02T02:00:00.000Z',
    positionFields: [
      { role: 'before', fieldId: 'f-before' },
      { role: 'after', fieldId: 'f-after' },
    ],
    axisLevels: ['x', 'y'].flatMap((axis) =>
      [1, 2, 3].map((levelNo) => ({ axis, levelNo, name: `${axis}段${levelNo}`, optionValues: [`${levelNo}`] })),
    ),
    cells,
    ratioGroups: [
      {
        id: 'g-1',
        name: '合成规则组',
        isDefault: true,
        controlScope: 'project_meeting',
        controlMode: 'block',
        minPopulation: 10,
        sortNo: 1,
        rules: [
          { operator: 'between', pctLow: 10, pctHigh: 20, cellNos: [9] },
          { operator: 'lte', pctLow: 15, pctHigh: null, cellNos: [1, 2] },
        ],
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  resetServer();
  server.fields[MATRIX] = matrixFields;
  server.fields['TalentReview.Field'] = ['id', 'name'];
  server.collections.matrices = [matrix('m-1', '合成九宫格甲'), matrix('m-2', '合成九宫格乙', { enabled: false })];
  server.collections.fields = [
    { id: 'f-x', name: '合成绩效' },
    { id: 'f-y', name: '合成能力' },
    { id: 'f-before', name: '合成校准前位置' },
    { id: 'f-after', name: '合成校准后位置' },
  ];
});
afterEach(unmount);

async function openMatrices() {
  await mount();
  await openTab('九宫格设置');
}
const section = (title: string) =>
  Array.from(document.querySelectorAll('.matrix-section')).find(
    (node) => squash(node.querySelector('h3')?.textContent) === title,
  ) as HTMLElement | undefined;

describe('AC-TR-F475B 九宫格详细设置', () => {
  it('设置整页：两个页签、配置胶囊、四个分区与锚点，没有列表、保存按钮', async () => {
    await openMatrices();
    const tabs = Array.from(document.querySelectorAll('.matrix-settings .ant-tabs-tab-btn')).map((n) => n.textContent);
    expect(tabs).toEqual(['九宫格详细设置', '九宫格通用设置']);
    const pills = Array.from(document.querySelectorAll('.matrix-settings .ant-radio-button-wrapper'));
    expect(pills.map((n) => squash(n.textContent))).toEqual(['合成九宫格甲', '合成九宫格乙']);
    expect(pills[0]!.className).toContain('ant-radio-button-wrapper-checked');
    const anchors = Array.from(document.querySelectorAll('.matrix-settings .ant-anchor-link-title'));
    expect(anchors.map((n) => n.textContent)).toEqual(['基础设置', '九宫格展示', '比例控制及说明', '导出设置']);
    expect(document.querySelector('.list-card')).toBeNull();
    expect(button('保存')).toBeUndefined();
    expect(server.writes).toEqual([]);
  });

  it('基础设置：字段按字段目录回显名称，校准调整与绿化率按真实值只读呈现', async () => {
    await openMatrices();
    const basic = section('基础设置')!;
    expect(text(basic)).toContain('X轴盘点字段合成绩效');
    expect(text(basic)).toContain('Y轴盘点字段合成能力');
    expect(text(basic)).toContain('校准前合成校准前位置');
    expect(text(basic)).toContain('校准后合成校准后位置');
    expect(text(basic)).toContain('优先校准后，无则校准前');
    const switches = Array.from(basic.querySelectorAll('button[role="switch"]'));
    expect(switches.length).toBeGreaterThanOrEqual(4);
    expect(switches.every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
    expect(switches.map((node) => node.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'true']);
    // 显示为 / 英文 / 繁体 / 字段说明 缺后端字段，标未完成
    expect(text(basic)).toContain('未完成（缺后端契约）');
  });

  it('九宫格展示：格子按后端横纵轴落位在页面内，不进抽屉或弹窗', async () => {
    await openMatrices();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const grid = section('九宫格展示')!.querySelector('.review-grid') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    const cell = Array.from(grid.querySelectorAll('.review-cell')).find(
      (n) => n.textContent === '合成格9',
    ) as HTMLElement;
    expect(cell.style.gridColumn).toBe('3');
    expect(cell.style.gridRow).toBe('1');
  });

  it('比例控制：规则表按原站列与列宽，运算符与值译成中文，增删复制未验证不开放', async () => {
    await openMatrices();
    const ratio = section('比例控制及说明')!;
    expect(text(ratio)).toContain('开启比例控制后，用户在九宫格中可以查看到比例限制规则及不符合比例时的提示');
    expect(text(ratio)).toContain('合成规则组');
    expect(headers(ratio)).toEqual(['序号', '*格子名称', '*运算符', '*值', '操作']);
    expect(headerWidths(ratio)).toEqual(['72px', '342px', '202px', '152px', '86px']);
    const rows = Array.from(ratio.querySelectorAll('tbody tr')).map((tr) => squash(tr.textContent));
    expect(rows[0]).toBe('1合成格9介于10%～20%');
    expect(rows[1]).toBe('2合成格1、合成格2小于等于15%');
    const checked = Array.from(ratio.querySelectorAll('.ant-radio-wrapper-checked')).map((n) => squash(n.textContent));
    expect(checked).toEqual(['盘点项目和校准会', '提示且不允许结束项目/校准会']);
    for (const label of ['添加', '添加规则组', '复制', '删除']) {
      const target = button(label, ratio)!;
      expect(target.disabled).toBe(true);
      expect(target.title).toBe('此操作未验证，暂不开放');
    }
  });

  it('导出设置按格子导出顺序列出；切换配置胶囊读取另一份九宫格详情', async () => {
    await openMatrices();
    expect(squash(text(section('导出设置')!))).toContain('1.合成格92.合成格83.合成格7');
    const second = document.querySelectorAll('.matrix-settings .ant-radio-button-input')[1]!;
    await click(second);
    expect(server.reads.some((url) => url.endsWith(`${base}/matrices/m-2`))).toBe(true);
    const switches = section('基础设置')!.querySelectorAll('button[role="switch"]');
    expect(switches[0]!.getAttribute('aria-checked')).toBe('false');
  });

  it('字段被裁剪时对应分区不显示值，也不回退成别的字段', async () => {
    server.fields[MATRIX] = matrixFields.filter((field) => !['ratioGroups', 'xFieldId'].includes(field));
    for (const row of server.collections.matrices!) {
      delete row.ratioGroups;
      delete row.xFieldId;
    }
    await openMatrices();
    expect(section('比例控制及说明')!.querySelector('table')).toBeNull();
    expect(text(section('基础设置')!)).not.toContain('X轴盘点字段');
    expect(text(section('基础设置')!)).toContain('Y轴盘点字段合成能力');
  });

  it('通用设置：姓名宽度与导出字段缺租户设置契约，选项只读并标未完成', async () => {
    await openMatrices();
    await openTab('九宫格通用设置');
    const general = document.querySelector('.matrix-general') as HTMLElement;
    expect(text(general)).toContain('姓名默认宽度设置');
    expect(text(general)).toContain('导出字段');
    expect(text(general)).toContain('未完成（缺后端契约）');
    const radios = Array.from(general.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios.map((input) => squash(input.closest('label')?.textContent))).toEqual([
      '固定宽度',
      '最大宽度适应显示',
      '自适应',
    ]);
    expect(radios.every((input) => input.disabled)).toBe(true);
    expect(button('保存')).toBeUndefined();
  });

  it('页面主标题“九宫格”在详细设置与通用设置两个页签下都保留（审查 P2-1）', async () => {
    await openMatrices();
    const title = () => Array.from(document.querySelectorAll('.matrix-settings h1')).map((n) => n.textContent);
    expect(title()).toEqual(['九宫格']);
    await openTab('九宫格通用设置');
    expect(title()).toEqual(['九宫格']);
    await openTab('九宫格详细设置');
    expect(title()).toEqual(['九宫格']);
  });

  it('集合首次读取 503 后点“重新加载”恢复配置内容，不发写请求（审查 P2-2）', async () => {
    const unavailable = { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } };
    server.readReplies.matrices = [json(unavailable, 503)];
    await openMatrices();
    expect(document.querySelector('.matrix-settings [role="alert"]')).not.toBeNull();
    expect(section('基础设置')).toBeUndefined();
    await click(button('重新加载'));
    expect(document.querySelector('.matrix-settings [role="alert"]')).toBeNull();
    expect(text(section('基础设置')!)).toContain('X轴盘点字段合成绩效');
    expect(server.writes).toEqual([]);
  });
});
