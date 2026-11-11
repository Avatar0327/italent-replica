/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { ProfilesPage } from './ProfilesPage.js';
const base = '/api/tenant/permission/profiles';
const id = '60000000-0000-4000-8000-000000000478';
const objectCode = 'Demo.Object';
const objectPath = `${base}/${id}/objects/${objectCode}`;
const profile = {
  id,
  name: '合成配置身份',
  code: 'SYNTH',
  apps: ['Demo'],
  source: 'custom',
  description: '',
  revision: 4,
  objects: [{ objectCode, dataOperations: { create: true, update: false, delete: false }, fields: [], buttons: [] }],
};
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
async function click(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.replace(/\s/g, '') === text,
  );
  expect(button, `按钮 ${text}`).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}
async function open(editable = true) {
  await ui.render(h(ProfilesPage, { title: '身份管理', editable }), '/', undefined, {
    [base]: { items: [profile], total: 1 },
    [`${base}/${id}`]: profile,
    [`${objectPath}/data-operations`]: {
      profileId: id,
      objectCode,
      revision: 4,
      dataOperations: profile.objects[0]!.dataOperations,
    },
    [`${objectPath}/fields`]: {
      profileId: id,
      objectCode,
      revision: 4,
      catalogDigest: '0123456789abcdef',
      total: 2,
      items: [
        { fieldCode: 'CreatedBy', system: true, view: true, edit: false },
        { fieldCode: 'Name', system: false, view: false, edit: true },
      ],
    },
  });
  await click(profile.name);
}
describe('AC-FE-F4745-A2b 对象列表与权限弹窗结构', () => {
  it('从身份列表进入整页对象表，六列按规格，不伪造缺失投影，返回列表', async () => {
    await open();
    expect(ui.headers()).toEqual(['名称', '编码', '应用', '分组', '最新修改时间', '操作']);
    expect(ui.widths()).toEqual([180, 180, 180, 180, 180, 320].map((n) => `${n}px`));
    const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
    expect(
      Array.from(cells)
        .slice(0, 5)
        .map((c) => c.textContent),
    ).toEqual(['—', objectCode, '—', '—', '—']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click('返回');
    expect(ui.headers()).toContain('最近修改人');
  });
  it('数据操作居中弹窗读取三个当前值，取消回对象列表', async () => {
    await open();
    await click('数据操作权限');
    const dialog = document.querySelector('.ant-modal');
    expect(dialog?.textContent).toContain('配置数据操作权限');
    expect(dialog?.querySelectorAll('input[type="radio"]')).toHaveLength(6);
    expect(Array.from(dialog!.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map((i) => i.checked)).toEqual(
      [true, false, false, true, false, true],
    );
    await click('取消');
    expect(ui.headers()).toContain('最新修改时间');
  });
  it('字段弹窗保留独立查看/编辑值，系统字段不可编辑，字段名为空', async () => {
    await open();
    await click('字段权限');
    const dialog = document.querySelector('.ant-modal');
    expect(Array.from(dialog!.querySelectorAll('thead th')).map((c) => c.textContent)).toEqual([
      '字段名',
      '编码',
      '查看',
      '编辑',
    ]);
    const rows = dialog!.querySelectorAll('tbody .ant-table-row');
    expect(rows[0]?.querySelector('td')?.textContent).toBe('—');
    expect(rows[0]?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled).toBe(true);
    expect(
      Array.from(rows[1]!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((i) => i.checked),
    ).toEqual([false, true]);
    expect(dialog!.textContent).toContain('100条/页');
  });
  it.each(['数据操作权限', '字段权限'])('只读菜单的%s可查看配置且不存在保存按钮', async (entry) => {
    await open(false);
    await click(entry);
    const dialog = document.querySelector('.ant-modal');
    const controls = Array.from(
      dialog!.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
    );
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((input) => input.disabled)).toBe(true);
    const save = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.replace(/\s/g, '') === '确定',
    );
    expect(save).toBeUndefined();
  });
});
