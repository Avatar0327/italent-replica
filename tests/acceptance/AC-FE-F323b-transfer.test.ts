/**
 * F-323b（DEC-706）：调动表单「原人员类别」显示字典名称，「调动后人员类别」是字典下拉、提交字典 ID。
 * HR / 经理入口的预览经 trimEmploymentResponse 已带 employmentTypeName（当前值与 before 原值）；
 * 员工入口的名称来自自助预览的 beforeLabels / valueLabels（适配器并入 beforeReferences / references）。
 */
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
import { loadReferences, transferBody } from '../../apps/web/src/transfer/api.js';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = require('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const web = (file: string) => new URL(`../../apps/web/src/${file}`, import.meta.url).pathname;
const BEFORE = '11111111-1111-4111-8111-111111111111';
const AFTER = '22222222-2222-4222-8222-222222222222';

function model(mode: 'editable' | 'readonly', initiator: 'hr' | 'manager' | 'employee' = 'hr'): TransferFormModel {
  return {
    initiator,
    employees: [],
    departments: [],
    catalog: { types: [], reasons: [] },
    employeeId: 'synthetic-employee',
    effectiveDate: '2026-10-05',
    transferTypeCode: 'cross_department',
    reasonCode: '',
    fields: {},
    customFields: {},
    preview: {
      form: {
        id: 'F',
        name: '合成调动表单',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: { 'preset:employmentType': mode },
        customFields: [],
      },
      // 与后端 trimEmploymentResponse 一致：ID 与名称并列
      fields: { employmentType: BEFORE, employmentTypeName: '合成类别甲' },
      customFields: {},
      before: { fields: { employmentType: BEFORE, employmentTypeName: '合成类别甲' }, customFields: {} },
      employeeRevision: 2,
      allowDirectTransfer: true,
    },
  };
}
const render = async (m: TransferFormModel) => {
  const { TransferForm } = (await import(web('self-service/shared/TransferForm.tsx'))) as { TransferForm: unknown };
  return renderToStaticMarkup(createElement(TransferForm, { model: m }));
};
afterEach(() => vi.unstubAllGlobals());

it('AC-FE-F323b 调动表单：原人员类别与只读的调动后人员类别显示字典名称，不显示「已保存的值」', async () => {
  for (const initiator of ['hr', 'manager'] as const) {
    const html = await render(model('readonly', initiator));
    expect(html).toMatch(/<output>合成类别甲<\/output>/);
    expect(html).toMatch(/<input(?=[^>]*name="employmentType")(?=[^>]*value="合成类别甲")[^>]*>/);
    expect(html).not.toContain('已保存的值');
  }
});

it('AC-FE-F323b 调动表单：可编辑时「调动后人员类别」是字典下拉，选项为启用类别，值是字典 ID', async () => {
  const editable = { ...model('editable'), references: { employmentType: [{ id: AFTER, name: '合成类别乙' }] } };
  const html = await render(editable);
  expect(html).toMatch(/<select[^>]*name="employmentType"/);
  expect(html).toContain(`<option value="${AFTER}">合成类别乙</option>`);
  // 当前值（停用或不在候选里）仍按名称显示
  expect(html).toContain(`<option value="${BEFORE}" selected="">合成类别甲</option>`);
  expect(html).not.toContain('已保存的值');
  const chosen = { ...editable, fields: { employmentType: AFTER } };
  expect(transferBody(chosen, 'submit')).toMatchObject({ fields: { employmentType: AFTER } });
});

it('AC-FE-F323b HR 入口可编辑人员类别时读取字典选项接口；只读时不读', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [{ id: AFTER, name: '合成类别乙', displayOrder: 1 }] }))),
  );
  const editable = model('editable');
  const loaded = await loadReferences('tenant', editable.preview!, editable, new AbortController().signal);
  expect(loaded.references.employmentType).toEqual([{ id: AFTER, name: '合成类别乙', displayOrder: 1 }]);
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.endsWith('/api/tenant/employment/employment-types/options'))).toBe(true);
  vi.mocked(fetch).mockClear();
  const readonly = model('readonly');
  await loadReferences('tenant', readonly.preview!, readonly, new AbortController().signal);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('AC-FE-F323b HR 入口人员类别选项读取失败：候选为空并提示参照不可用，原值仍按名称显示', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code: 'FORBIDDEN', message: '无权查看' }), { status: 403 })),
  );
  const editable = model('editable');
  const loaded = await loadReferences('tenant', editable.preview!, editable, new AbortController().signal);
  expect(loaded.references.employmentType).toEqual([]);
  expect(loaded.unavailable).toBe(true);
  const html = await render({ ...editable, references: loaded.references });
  expect(html).toContain(`<option value="${BEFORE}" selected="">合成类别甲</option>`);
});

it('AC-FE-F455 经理 / 员工入口无字典参照：即使配置可编辑，也只读显示人员类别名称', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const initiator of ['manager', 'employee'] as const) {
    const current = model('editable', initiator);
    const loaded = await loadReferences('tenant', current.preview!, current, new AbortController().signal);
    const html = await render({ ...current, references: loaded.references });
    expect(html).not.toMatch(/<select[^>]*name="employmentType"/);
    expect(html).toMatch(/<input(?=[^>]*name="employmentType")(?=[^>]*readOnly="")(?=[^>]*value="合成类别甲")[^>]*>/);
    expect(html).not.toContain('已保存的值');
    expect(transferBody(current, 'submit').fields).not.toHaveProperty('employmentType');
  }
  expect(fetcher).not.toHaveBeenCalled();
});
