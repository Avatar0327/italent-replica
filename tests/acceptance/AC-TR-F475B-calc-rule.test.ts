/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-475 2/3 盘点 B：盘点计算规则列表 / 基础编辑（R3cd spec §2.6、§3.3）。原站列表无筛选、无复选，右上新增；
 * 状态草稿 / 启用 / 停用，复刻后端只有 enabled，不伪造草稿。行编辑打开约 750px 居中基础弹窗（规则名、应用说明），
 * 公式 / 输出条件未取证，不进弹窗。保存接表单提交内核（F-123，DEC-502①）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base,
  button,
  click,
  conflict,
  formItem,
  headerWidths,
  headers,
  json,
  mount,
  openTab,
  resetServer,
  server,
  squash,
  text,
  type,
  unmount,
} from './support/talent-review-f475b.js';

const CALC_RULE = 'TalentReview.CalcRule';
const ruleFields = [
  'id',
  'revision',
  'name',
  'enabled',
  'assessmentLatestWindow',
  'description',
  'items',
  'sortNo',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
];
/** 与 calc-rule-view.ts 的 CalcRuleView 同形：规则行 + items（计算项目）。 */
function rule(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    enabled: true,
    assessmentLatestWindow: 'before_project_end',
    description: '合成说明',
    sortNo: 1,
    revision: 5,
    createdBy: 'u-1',
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedBy: 'u-1',
    updatedAt: '2026-10-02T02:00:00.000Z',
    items: [{ targetFieldId: 'f-1', priority: 1, formula: '1', description: null, sortNo: 1, usesRanking: false }],
    ...extra,
  };
}

beforeEach(() => {
  resetServer();
  server.fields[CALC_RULE] = ruleFields;
  server.collections['calc-rules'] = [
    rule('r-1', '合成规则甲'),
    rule('r-2', '合成规则乙', { enabled: false, description: null }),
  ];
});
afterEach(unmount);

async function openRules() {
  await mount();
  await openTab('盘点计算规则');
}
const list = () => document.querySelector('.review-calc-rule-list') as HTMLElement | null;
const dialog = () => document.querySelector('.review-calc-rule-form .ant-modal') as HTMLElement | null;
const rows = () => Array.from(list()!.querySelectorAll('tbody tr.ant-table-row'));
const cells = (row: Element) => Array.from(row.querySelectorAll('td')).map((td) => squash(td.textContent));
const nameInput = () => formItem('规则名', dialog()!)!.querySelector('input') as HTMLInputElement;
const descriptionInput = () => formItem('应用说明', dialog()!)!.querySelector('textarea') as HTMLTextAreaElement;
async function edit(index = 0) {
  await click(button('编辑', rows()[index]));
}

describe('AC-TR-F475B 盘点计算规则列表', () => {
  it('列与列宽按原站，无筛选无复选，状态只显示启用 / 停用，分页常显', async () => {
    await openRules();
    expect(headers(list()!)).toEqual(['规则名', '应用说明', '状态', '创建人', '最近一次修改时间', '操作', '⚙']);
    expect(headerWidths(list()!)).toEqual(['211px', '211px', '181px', '201px', '229px', '160px', '24px']);
    expect(list()!.querySelector('.page-filters')).toBeNull();
    expect(list()!.querySelector('.ant-checkbox')).toBeNull();
    expect(cells(rows()[0]!)).toEqual([
      '合成规则甲',
      '合成说明',
      '启用',
      'u-1',
      '2026-10-0210:00:00',
      '编辑停用复制',
      '',
    ]);
    expect(rows()[0]!.querySelectorAll('td')[4]!.textContent).toBe('2026-10-02 10:00:00');
    expect(cells(rows()[1]!).slice(0, 3)).toEqual(['合成规则乙', '--', '停用']);
    expect(cells(rows()[1]!)[5]).toBe('编辑启用复制');
    expect(text(list()!)).not.toContain('草稿');
    // 规则名蓝色；原站经行编辑打开弹窗，点规则名未取证，不做成按钮。
    expect(rows()[0]!.querySelector('td .review-name-text')?.textContent).toBe('合成规则甲');
    expect(button('合成规则甲', list()!)).toBeUndefined();
    expect(squash(list()!.querySelector('.page-total')?.textContent)).toBe('共2条');
    expect(list()!.querySelector('.ant-pagination')).not.toBeNull();
    expect(text(list()!)).toContain('15条/页');
    expect(text(list()!)).toContain('共1页');
  });

  it('新增 / 停用 / 启用未取证、复制缺契约：保留入口但禁用', async () => {
    await openRules();
    const create = button('新增', list()!.querySelector('.page-heading')!)!;
    expect([create.disabled, create.title]).toEqual([true, '此操作未验证，暂不开放']);
    const toggle = button('停用', rows()[0])!;
    expect([toggle.disabled, toggle.title]).toEqual([true, '此操作未验证，暂不开放']);
    expect(button('启用', rows()[1])!.disabled).toBe(true);
    const copy = button('复制', rows()[0])!;
    expect([copy.disabled, copy.title]).toEqual([true, '未完成（缺后端契约）']);
    expect(button('编辑', rows()[0])!.disabled).toBe(false);
  });

  it('没有编辑权时不显示编辑；应用说明被裁剪时不出列、弹窗也不出字段', async () => {
    server.buttons = ['create'];
    await openRules();
    expect(button('编辑', rows()[0])).toBeUndefined();
    await unmount();
    resetServer();
    server.fields[CALC_RULE] = ruleFields.filter((field) => field !== 'description');
    server.collections['calc-rules'] = [rule('r-1', '合成规则甲')];
    await openRules();
    expect(headers(list()!)).not.toContain('应用说明');
    await edit();
    expect(formItem('应用说明', dialog()!)).toBeUndefined();
  });
});

describe('AC-TR-F475B 盘点计算规则基础编辑', () => {
  it('居中弹窗：标题编辑，右上翻译助手 / 配置表单禁用，规则名必填，应用说明计数 /200，不含公式', async () => {
    await openRules();
    await edit();
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    const title = dialog()!.querySelector('.ant-modal-title')!;
    expect(squash(title.textContent)).toBe('编辑翻译助手配置表单');
    for (const label of ['翻译助手', '配置表单']) {
      const extra = button(label, title as HTMLElement)!;
      expect([extra.disabled, extra.title]).toEqual([true, '此操作未验证，暂不开放']);
    }
    expect(formItem('规则名', dialog()!)!.querySelector('.ant-form-item-required')).not.toBeNull();
    expect(nameInput().value).toBe('合成规则甲');
    expect(descriptionInput().value).toBe('合成说明');
    expect(text(formItem('应用说明', dialog()!)!)).toContain('4/200');
    expect(text(dialog()!)).not.toContain('计算表达式');
    expect(button('取消', dialog()!)).toBeDefined();
    expect(button('保存', dialog()!)).toBeDefined();
  });

  it('只发改过的字段，名称去空格，If-Match 用记录版本；成功后关闭并重读列表', async () => {
    await openRules();
    await edit();
    await type(nameInput(), '  合成规则甲改  ');
    await click(button('保存', dialog()!));
    expect(server.writes).toHaveLength(1);
    const [sent] = server.writes;
    expect([sent!.method, sent!.url, sent!.ifMatch]).toEqual(['PATCH', `${base}/calc-rules/r-1`, '5']);
    expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent!.body).toEqual({ name: '合成规则甲改' });
    expect(dialog()).toBeNull();
    expect(cells(rows()[0]!)[0]).toBe('合成规则甲改');
  });

  it('规则名为空不提交；应用说明改到超过 200 字不提交，清空发 null', async () => {
    await openRules();
    await edit();
    await type(nameInput(), '   ');
    await click(button('保存', dialog()!));
    expect(server.writes).toEqual([]);
    expect(text(dialog()!)).toContain('请填写此项');
    await type(nameInput(), '合成规则甲');
    await type(descriptionInput(), '说'.repeat(201));
    await click(button('保存', dialog()!));
    expect(server.writes).toEqual([]);
    expect(text(dialog()!)).toContain('最多200字');
    await type(descriptionInput(), '');
    await click(button('保存', dialog()!));
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.body).toEqual({ description: null });
  });

  it('超过 200 字的旧说明（后端上限 500）未改动时照常保存其他字段', async () => {
    server.collections['calc-rules']![0]!.description = '旧'.repeat(250);
    await openRules();
    await edit();
    await type(nameInput(), '合成规则甲改');
    await click(button('保存', dialog()!));
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.body).toEqual({ name: '合成规则甲改' });
  });

  it('409 重读核对差异：未改字段取最新值，重提用最新版本', async () => {
    await openRules();
    await edit();
    Object.assign(server.collections['calc-rules']![0]!, { name: '他人改名', description: '他人说明', revision: 6 });
    server.replies.push(conflict());
    await type(nameInput(), '我的改名');
    await click(button('保存', dialog()!));
    expect(text(dialog()!)).toContain('版本冲突');
    await click(button('重读最新版本', dialog()!));
    expect(server.reads.at(-1)).toBe(`${base}/calc-rules/r-1`);
    await click(button('已核对差异，继续编辑', dialog()!));
    expect(nameInput().value).toBe('我的改名');
    expect(descriptionInput().value).toBe('他人说明');
    await click(button('保存', dialog()!));
    expect(server.writes).toHaveLength(2);
    expect([server.writes[1]!.ifMatch, server.writes[1]!.body]).toEqual(['6', { name: '我的改名' }]);
  });

  it('回执版本未前进判为结果未知：只读锁定', async () => {
    await openRules();
    await edit();
    server.replies.push(json(rule('r-1', '合成规则甲改')));
    await type(nameInput(), '合成规则甲改');
    await click(button('保存', dialog()!));
    expect(text(dialog()!)).toContain('处理中 / 结果待确认');
    expect(button('保存', dialog()!)!.disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
  });

  it('网络失败结果未知：关闭后切页签再打开仍锁定，不另起命令', async () => {
    await openRules();
    await edit();
    server.replies.push(new TypeError('fetch failed'));
    await type(nameInput(), '合成规则甲改');
    await click(button('保存', dialog()!));
    expect(text(dialog()!)).toContain('处理中 / 结果待确认');
    await click(button('取消', dialog()!));
    await openTab('盘点模板');
    await openTab('盘点计算规则');
    await edit();
    expect(text(dialog()!)).toContain('处理中 / 结果待确认');
    expect(button('保存', dialog()!)!.disabled).toBe(true);
    await click(button('保存', dialog()!));
    expect(server.writes).toHaveLength(1);
  });
});
