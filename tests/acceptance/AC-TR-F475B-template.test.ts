/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-475 2/3 盘点 B：盘点模板列表 / 整页第一步（R3cd spec §2.6、§3.3）。原站列表有名称 / 所属组织 / 状态筛选、复选、
 * 新增 / 停用 / 启用工具，行操作复制 / 编辑 / 删除；模板整页三步只取证第一步。保存接表单提交内核（F-123，DEC-502①）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base,
  button,
  choose,
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

const TEMPLATE = 'TalentReview.Template';
const FLOW = 'TalentReview.Flow';
const templateFields = [
  'id',
  'revision',
  'createdBy',
  'createdAt',
  'updatedAt',
  'name',
  'ownerOrgId',
  'downwardPublic',
  'flowId',
  'enabled',
  'currentVersionNo',
  'steps',
  'modules',
  'permissions',
];
/** 与 template-routes.ts 列表行同形：headerColumns + versionNo + accessLevel。 */
function template(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    ownerOrgId: 'org-1',
    downwardPublic: true,
    flowId: 'flow-1',
    enabled: true,
    currentVersionNo: 2,
    revision: 3,
    createdBy: 'u-1',
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedBy: 'u-1',
    updatedAt: '2026-10-02T02:00:00.000Z',
    versionNo: 2,
    accessLevel: 'manage',
    ...extra,
  };
}

beforeEach(() => {
  resetServer();
  server.fields[TEMPLATE] = templateFields;
  server.fields[FLOW] = ['id', 'name'];
  server.collections.templates = [
    template('t-1', '合成模板甲'),
    template('t-2', '合成模板乙', { accessLevel: 'readonly', enabled: false, downwardPublic: false, flowId: null }),
  ];
  server.collections.flows = [{ id: 'flow-1', name: '合成流程一' }];
  server.collections.organizations = [{ id: 'org-1', name: '合成组织一' }];
});
afterEach(unmount);

async function openTemplates() {
  await mount();
  await openTab('盘点模板');
}
const list = () => document.querySelector('.review-template-list') as HTMLElement | null;
const page = () => document.querySelector('.review-template-page') as HTMLElement | null;
const rows = () => Array.from(list()!.querySelectorAll('tbody tr.ant-table-row'));
const cells = (row: Element) => Array.from(row.querySelectorAll('td')).map((td) => squash(td.textContent));
const nameInput = () => formItem('模板名称', page()!)!.querySelector('input') as HTMLInputElement;
async function openTemplate(name: string) {
  await click(button(name, list()!));
}

describe('AC-TR-F475B 盘点模板列表', () => {
  it('列与列宽按原站，创建时间按租户时区，流程回显名称，没有刷新与当前版本', async () => {
    await openTemplates();
    expect(headers(list()!)).toEqual([
      '',
      '模板名称',
      '盘点流程',
      '所属组织',
      '向下公开',
      '状态',
      '创建人',
      '创建时间',
      '操作',
      '⚙',
    ]);
    expect(headerWidths(list()!)).toEqual([
      '30px',
      '148px',
      '149px',
      '149px',
      '149px',
      '119px',
      '139px',
      '167px',
      '160px',
      '26px',
    ]);
    const nameHeader = Array.from(list()!.querySelectorAll('thead th')).find(
      (th) => squash(th.textContent) === '模板名称',
    );
    expect(nameHeader!.className).toContain('ant-table-column-has-sorters');
    expect(cells(rows()[0]!)).toEqual([
      '',
      '合成模板甲',
      '合成流程一',
      'org-1',
      '是',
      '启用',
      'u-1',
      '2026-10-0110:00:00',
      '复制编辑删除',
      '',
    ]);
    // cells() 去掉全部空白；时间列另核原文，日期与时间之间保留一个空格（租户时区 Asia/Shanghai）。
    expect(rows()[0]!.querySelectorAll('td')[7]!.textContent).toBe('2026-10-01 10:00:00');
    expect(cells(rows()[1]!).slice(1, 6)).toEqual(['合成模板乙', '--', 'org-1', '否', '停用']);
    expect(button('刷新')).toBeUndefined();
    expect(text(list()!)).not.toContain('当前版本');
    expect(squash(list()!.querySelector('.page-total')?.textContent)).toBe('共2条');
    expect(list()!.querySelector('.ant-pagination')).toBeNull();
  });

  it('工具栏新增可用、停用 / 启用未验证；行内复制 / 删除未验证，只读行没有编辑', async () => {
    await openTemplates();
    const heading = list()!.querySelector('.page-heading')!;
    expect(button('新增', heading)!.disabled).toBe(false);
    for (const label of ['停用', '启用']) {
      expect(button(label, heading)!.disabled).toBe(true);
      expect(button(label, heading)!.title).toBe('此操作未验证，暂不开放');
    }
    const [first, second] = rows();
    for (const label of ['复制', '删除']) {
      expect(button(label, first)!.disabled).toBe(true);
      expect(button(label, first)!.title).toBe('此操作未验证，暂不开放');
    }
    expect(button('编辑', first)!.disabled).toBe(false);
    expect(button('编辑', second)).toBeUndefined();
    await click(first!.querySelector('input[type="checkbox"]'));
    expect(squash(list()!.querySelector('.page-total')?.textContent)).toBe('已选中1条，共2条');
  });

  it('筛选：名称、所属组织、状态；名称与状态按本页数据过滤', async () => {
    await openTemplates();
    const filters = list()!.querySelector('.page-filters') as HTMLElement;
    expect(squash(filters.textContent)).toBe('名称▾所属组织▾状态');
    await click(button('名称▾', filters));
    await type(document.querySelector('input[aria-label="搜索名称"]') as HTMLInputElement, '乙');
    await click(button('确定'));
    expect(rows().map((row) => cells(row)[1])).toEqual(['合成模板乙']);
    await click(button('名称▾', filters));
    await type(document.querySelector('input[aria-label="搜索名称"]') as HTMLInputElement, '');
    await click(button('确定'));
    await choose(filters, '启用');
    expect(rows().map((row) => cells(row)[1])).toEqual(['合成模板甲']);
  });
});

describe('AC-TR-F475B 盘点模板整页', () => {
  it('点名称进入整页：三步导航停在基本信息，右上返回，字段与必填按原站', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    expect(list()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const steps = Array.from(page()!.querySelectorAll('.ant-steps-item'));
    expect(steps.map((step) => squash(step.querySelector('.ant-steps-item-title')?.textContent))).toEqual([
      '基本信息',
      '模块设置',
      '权限设置',
    ]);
    expect(steps[0]!.className).toContain('ant-steps-item-process');
    expect(button('返回', page()!.querySelector('.page-heading')!)).toBeDefined();
    for (const label of ['模板名称', '盘点流程', '所属组织', '向下公开', '状态'])
      expect(formItem(label, page()!)!.querySelector('.ant-form-item-required'), label).not.toBeNull();
    expect(nameInput().value).toBe('合成模板甲');
    const config = button('配置', formItem('盘点流程', page()!))!;
    expect([config.disabled, config.title]).toEqual([true, '此操作未验证，暂不开放']);
    const publicItem = formItem('向下公开', page()!)!;
    expect(squash(publicItem.querySelector('.ant-radio-wrapper-checked')?.textContent)).toBe('是');
    expect(squash(formItem('状态', page()!)!.querySelector('.ant-select-selection-item')?.textContent)).toBe('启用');
    const description = formItem('描述', page()!)!;
    expect(description.querySelector('.ant-form-item-required')).toBeNull();
    expect((description.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(text(description)).toContain('0/200');
    expect(text(description)).toContain('未完成（缺后端契约）');
    expect(button('保存', page()!)!.disabled).toBe(false);
    const next = button('下一步', page()!)!;
    expect([next.disabled, next.title]).toEqual([true, '此操作未验证，暂不开放']);
    await click(button('返回', page()!));
    expect(rows()).toHaveLength(2);
  });

  it('行内编辑同样进入整页；只读模板字段不可改、没有保存', async () => {
    await openTemplates();
    await click(button('编辑', rows()[0]));
    expect(nameInput().value).toBe('合成模板甲');
    await click(button('返回', page()!));
    await openTemplate('合成模板乙');
    expect(nameInput().disabled).toBe(true);
    expect(button('保存', page()!)).toBeUndefined();
  });
});

describe('AC-TR-F475B 盘点模板保存接表单内核', () => {
  it('编辑只发改过的字段，If-Match 用记录版本；成功后回到列表并重读', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    await type(nameInput(), '  合成模板甲改  ');
    await click(button('保存', page()!));
    expect(server.writes).toHaveLength(1);
    const [sent] = server.writes;
    expect([sent!.method, sent!.url, sent!.ifMatch]).toEqual(['PATCH', `${base}/templates/t-1`, '3']);
    expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent!.body).toEqual({ name: '合成模板甲改' });
    expect(page()).toBeNull();
    expect(cells(rows()[0]!)[1]).toBe('合成模板甲改');
  });

  it('没有修改不发请求', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    await click(button('保存', page()!));
    expect(server.writes).toEqual([]);
    expect(text(page()!)).toContain('没有修改，无需保存');
  });

  it('409 重读核对差异：未改字段取最新值，改回最新值不提交，重提用最新版本', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    Object.assign(server.collections.templates![0]!, { name: '他人改名', downwardPublic: false, revision: 4 });
    server.replies.push(conflict());
    await type(nameInput(), '我的改名');
    await click(button('保存', page()!));
    expect(text(page()!)).toContain('版本冲突');
    await click(button('重读最新版本', page()!));
    expect(server.reads.at(-1)).toBe(`${base}/templates/t-1`);
    await click(button('已核对差异，继续编辑', page()!));
    expect(nameInput().value).toBe('我的改名');
    expect(squash(formItem('向下公开', page()!)!.querySelector('.ant-radio-wrapper-checked')?.textContent)).toBe('否');
    await type(nameInput(), '他人改名');
    await click(button('保存', page()!));
    expect(server.writes).toHaveLength(1);
    await type(nameInput(), '我的改名');
    await click(button('保存', page()!));
    expect(server.writes).toHaveLength(2);
    expect([server.writes[1]!.ifMatch, server.writes[1]!.body]).toEqual(['4', { name: '我的改名' }]);
  });

  it('回执版本未前进判为结果未知：只读锁定', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    server.replies.push(json(template('t-1', '合成模板甲改')));
    await type(nameInput(), '合成模板甲改');
    await click(button('保存', page()!));
    expect(text(page()!)).toContain('处理中 / 结果待确认');
    expect(button('保存', page()!)!.disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
  });

  it('网络失败结果未知：换入口重开仍锁定，不另起命令', async () => {
    await openTemplates();
    await openTemplate('合成模板甲');
    server.replies.push(new TypeError('fetch failed'));
    await type(nameInput(), '合成模板甲改');
    await click(button('保存', page()!));
    expect(text(page()!)).toContain('处理中 / 结果待确认');
    await click(button('返回', page()!));
    await click(button('编辑', rows()[0]));
    expect(text(page()!)).toContain('处理中 / 结果待确认');
    expect(button('保存', page()!)!.disabled).toBe(true);
    await click(button('保存', page()!));
    expect(server.writes).toHaveLength(1);
  });

  it('新增：必填校验、启用须选流程，提交到集合路径', async () => {
    await openTemplates();
    await click(button('新增', list()!.querySelector('.page-heading')!));
    expect(squash(page()!.querySelector('.page-heading h1')?.textContent)).toBe('新增盘点模板');
    await click(button('保存', page()!));
    expect(server.writes).toEqual([]);
    expect(text(page()!)).toContain('请填写此项');
    await type(nameInput(), '合成新模板');
    await choose(formItem('所属组织', page()!)!, '合成组织一');
    await click(formItem('向下公开', page()!)!.querySelectorAll('input[type="radio"]')[1]);
    await choose(formItem('状态', page()!)!, '启用');
    await click(button('保存', page()!));
    expect(server.writes).toEqual([]);
    expect(text(page()!)).toContain('启用模板须先选择盘点流程');
    await choose(formItem('状态', page()!)!, '停用');
    await click(button('保存', page()!));
    expect(server.writes).toHaveLength(1);
    const [sent] = server.writes;
    expect([sent!.method, sent!.url, sent!.ifMatch]).toEqual(['POST', `${base}/templates`, '0']);
    expect(sent!.body).toMatchObject({
      name: '合成新模板',
      ownerOrgId: 'org-1',
      downwardPublic: false,
      enabled: false,
    });
    expect(rows().map((row) => cells(row)[1])).toContain('合成新模板');
  });
});
