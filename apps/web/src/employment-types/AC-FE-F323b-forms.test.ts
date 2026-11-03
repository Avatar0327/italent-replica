// @vitest-environment happy-dom
/**
 * F-323b（DEC-706）：任职存人员类别字典 ID。编辑任职、兼职申请 / 直接兼职表单的人员类别是字典下拉，
 * 选项取 /employment-types/options（只含启用项），提交字典 ID；只读与详情显示后端附带的 employmentTypeName。
 * 夹具形状：任职 / 兼职返回经 trimEmploymentResponse（employmentTypeNames）在 employmentType 旁并列名称；
 * 选项项形状由 tests/acceptance/AC-EMP-F323b-labels 用真实接口核对。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Form } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { RecordEdit } from '../personnel/EditCommands.js';
import { RequestControl } from '../part-time/RequestControl.js';
import { DirectField } from '../part-time/DirectFields.js';
import { cellValue, type Row as PartTimeRow } from '../part-time/model.js';
import { employmentTypeOption, employmentTypeRow } from '../../smoke/employment-type-fixtures.js';

const BEFORE = '11111111-1111-4111-8111-111111111111';
const AFTER = '22222222-2222-4222-8222-222222222222';
const OPTIONS = '/api/tenant/employment/employment-types/options';
const options = [employmentTypeOption(employmentTypeRow({ id: AFTER, name: '合成类别乙', displayOrder: 2 }))];
let host: HTMLDivElement;
let root: Root;
let writes: { url: string; method: string; body: unknown }[];

const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-hr',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成人事',
  source: 'server' as const,
};
const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
async function render(children: unknown) {
  await act(async () => root.render(h(SessionProvider, { session, children } as never)));
  await settle();
}
const selectIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLElement>('.ant-select')].find(
    (node) => node.querySelector(`[aria-label="${label}"]`) || node.getAttribute('aria-label') === label,
  );
async function choose(select: HTMLElement, name: string) {
  await act(async () => {
    select.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
    (node) => node.textContent === name,
  );
  expect(option, `选项 ${name}`).toBeDefined();
  await act(async () => option!.click());
  await settle();
}
const shown = (select: HTMLElement | undefined) => select?.querySelector('.ant-select-selection-item')?.textContent;
const optionsRead = () => vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith(OPTIONS));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 'synthetic-record', revision: 3 });
    }
    if (url.endsWith(OPTIONS)) return Response.json({ items: options });
    return Response.json({ items: [] });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-FE-F323b 编辑任职：人员类别', () => {
  const permission: ObjectPermission = {
    objectCode: 'TenantBase.EmploymentRecord',
    dataOperations: { update: true },
    buttons: [{ buttonCode: 'Employment.Edit', level: 'detail' }],
    viewableFields: ['departmentId', 'employmentType'],
    editableFields: ['employmentType'],
  };
  const record = {
    id: 'synthetic-record',
    revision: 2,
    kind: 'hire',
    status: 'effective',
    fields: { departmentId: 'synthetic-department', employmentType: BEFORE, employmentTypeName: '合成类别甲' },
  };

  it('有人员类别编辑权时出现在「编辑任职」里：下拉显示当前名称，选项取字典，提交字典 ID', async () => {
    await render(h(RecordEdit, { record, permission, saved() {} }));
    const open = [...document.querySelectorAll('button')].find((node) => node.textContent === '编辑任职');
    expect(open, '编辑任职').toBeDefined();
    await act(async () => open!.click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const select = selectIn(dialog, '人员类别');
    expect(select, '人员类别下拉').toBeDefined();
    expect(shown(select)).toBe('合成类别甲');
    expect(dialog.textContent).not.toContain(BEFORE);
    expect(optionsRead()).toBe(true);
    await choose(select!, '合成类别乙');
    const save = [...dialog.querySelectorAll('button')].find((node) => node.textContent?.replace(/\s/g, '') === '保存');
    await act(async () => save!.click());
    await settle();
    expect(writes).toEqual([
      {
        url: '/api/tenant/employment/records/synthetic-record',
        method: 'PATCH',
        body: { fields: { employmentType: AFTER } },
      },
    ]);
  });
});

describe('AC-FE-F323b 兼职：人员类别', () => {
  it('兼职申请表单：人员类别是字典下拉，选中提交字典 ID', async () => {
    const changed = vi.fn();
    await render(h(RequestControl, { field: 'employmentType', label: '人员类别', value: null, onChange: changed }));
    const select = selectIn(host, '人员类别');
    expect(select, '人员类别下拉').toBeDefined();
    expect(host.querySelector('textarea')).toBeNull();
    expect(optionsRead()).toBe(true);
    await choose(select!, '合成类别乙');
    expect(changed).toHaveBeenLastCalledWith(AFTER);
  });

  it('直接兼职：新增时人员类别是字典下拉；编辑时只读显示名称，不显示 ID', async () => {
    const access = (editable: boolean) => ({ field: () => ({ visible: true, editable }) }) as never;
    const baseline = { employmentType: BEFORE, employmentTypeName: '合成类别甲' };
    const form = (editable: boolean) =>
      h(Form, {
        initialValues: editable ? {} : baseline,
        children: h(DirectField, { name: 'employmentType', create: editable, access: access(editable), baseline }),
      });
    await render(form(true));
    const select = selectIn(host, '人员类别');
    expect(select, '人员类别下拉').toBeDefined();
    expect(host.querySelector('input:not([role="combobox"])')).toBeNull();
    await render(form(false));
    expect(host.textContent).toContain('合成类别甲');
    expect(host.textContent).not.toContain(BEFORE);
  });

  it('兼职列表 / 详情单元格显示人员类别名称；名称查不到时显示占位，不回落 ID', () => {
    const row = { id: 'p', fields: { employmentType: BEFORE, employmentTypeName: '合成类别甲' } } as PartTimeRow;
    expect(cellValue(row, 'employmentType', 'ongoing' as never)).toBe('合成类别甲');
    const unnamed = { id: 'p', fields: { employmentType: BEFORE, employmentTypeName: null } } as PartTimeRow;
    expect(cellValue(unnamed, 'employmentType', 'ongoing' as never)).not.toContain(BEFORE);
  });
});
