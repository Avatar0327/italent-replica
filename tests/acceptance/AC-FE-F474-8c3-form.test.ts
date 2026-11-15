/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-8c-3（设计 F-474-8b §5，AC-INS-01～04 / 09）：调动表单“薪资调整”组的社保三项，原值只读、调整值可编辑；
 * 地区选择器按 parent 懒加载；方案按缴交地 + 生效日取候选。接口形状按 insurance/routes.ts 与 linkage/view.ts。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkageDraft, LinkageView, TransferFormModel } from '../../apps/web/src/transfer/types.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, useState } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { HrTransferForm } = await import(resolve('apps/web/src/transfer/HrTransferForm.tsx'));
const { LinkagePanel } = await import(resolve('apps/web/src/transfer/LinkagePanel.tsx'));
const { transferBody, transferRequest } = await import(resolve('apps/web/src/transfer/api.ts'));
const { emptyLinkage } = await import(resolve('apps/web/src/transfer/linkage-api.ts'));
const draftRestore = await import(resolve('apps/web/src/transfer/draft-restore.ts'));

const EMPLOYEE = '81000000-0000-4000-8000-000000000001';
const OTHER = '81000000-0000-4000-8000-000000000002';
const DRAFT = '84000000-0000-4000-8000-000000000001';
const PLAN_OLD = '82000000-0000-4000-8000-000000000001';
const PLAN_NEW = '82000000-0000-4000-8000-000000000002';
const PLAN_GZ = '82000000-0000-4000-8000-000000000003';
const COMPANY_OLD = '83000000-0000-4000-8000-000000000001';
const COMPANY_NEW = '83000000-0000-4000-8000-000000000002';
const DATE = '2026-11-20';
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const region = (code: string, parentCode: string | null, level: number, name: string) => ({
  code,
  parentCode,
  level,
  name,
});
// GET /api/tenant/insurance/regions?parent=：直辖市区县直接挂省级编码；东莞市、台湾省没有下级
const REGIONS: Record<string, unknown[]> = {
  '': [region('110000', null, 1, '北京市'), region('440000', null, 1, '广东省'), region('710000', null, 1, '台湾省')],
  '110000': [region('110101', '110000', 3, '东城区'), region('110108', '110000', 3, '海淀区')],
  '440000': [region('440100', '440000', 2, '广州市'), region('441900', '440000', 2, '东莞市')],
  '440100': [region('440103', '440100', 3, '荔湾区')],
  '441900': [],
  '710000': [],
};
const plan = (planId: string | undefined, name: string, regionCode: string) => ({
  ...(planId ? { planId } : {}),
  code: name,
  name,
  regionCode,
  effectiveMonth: '2026-01-01',
  stopMonth: null,
  enabled: true,
});
// GET /api/tenant/insurance/plans?regionCode&asOf：缴交地或其上级的方案；planId 列可能因字段权限被去掉
const PLANS: Record<string, unknown[]> = {
  '110108': [plan(PLAN_OLD, '北京基本方案', '110000'), plan(PLAN_NEW, '北京补充方案', '110000')],
  '440103': [plan(PLAN_GZ, '广州方案', '440100'), plan(undefined, '无标识方案', '440000')],
};
const COMPANIES = [
  { id: COMPANY_OLD, code: 'C01', name: '合成甲公司' },
  { id: COMPANY_NEW, code: 'C02', name: '合成乙公司' },
];
interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
const ok = (body: unknown): Reply => ({ body });
// 错误体形状按 apps/api/src/errors.ts errorResponse
const fail = (status: number, code: string): Reply => ({ status, body: { error: { code, message: '合成拒绝' } } });
let origin: Reply;
let plans: (code: string) => Reply;
let companies: Reply;
let calls: string[];

function stubApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://local');
      calls.push(`${url.pathname}${url.search}`);
      const reply =
        url.pathname === '/api/tenant/transfer/insurance-origin'
          ? origin
          : url.pathname === '/api/tenant/insurance/regions'
            ? ok({ items: REGIONS[url.searchParams.get('parent') ?? ''] ?? [] })
            : url.pathname === '/api/tenant/insurance/plans'
              ? plans(url.searchParams.get('regionCode') ?? '')
              : url.pathname === '/api/tenant/insurance/companies'
                ? companies
                : fail(404, 'NOT_FOUND');
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }),
  );
}

const catalog = {
  today: DATE,
  types: [{ code: 'transfer', name: '部门间调动', formId: 'TenantBase.Transfer' }],
  reasons: [],
};
function model(linkage: Partial<LinkageDraft> = {}): TransferFormModel {
  return {
    initiator: 'hr',
    employees: [
      { id: EMPLOYEE, code: 'DEMO-001', name: '合成调动人', revision: 3 },
      { id: OTHER, code: 'DEMO-002', name: '合成同事', revision: 1 },
    ],
    departments: [],
    catalog,
    employeeId: EMPLOYEE,
    effectiveDate: DATE,
    transferTypeCode: 'transfer',
    reasonCode: '',
    fields: {},
    customFields: {},
    linkage: { ...emptyLinkage, ...linkage } as LinkageDraft,
    contracts: [],
    preview: {
      form: {
        id: 'TenantBase.Transfer',
        name: '部门间调动',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: {},
        customFields: [],
      },
      fields: {},
      customFields: {},
      before: null,
      employeeRevision: 3,
      allowDirectTransfer: false,
      allowedActions: { application: true, directList: true, directRow: true },
    },
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let current: TransferFormModel;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  origin = ok({ regionCode: '110108', planId: PLAN_OLD, companyId: COMPANY_OLD });
  plans = (code) => ok({ items: PLANS[code] ?? [] });
  companies = ok({ items: COMPANIES });
  stubApi();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Harness({ initial }: { initial: TransferFormModel }) {
  const [state, setState] = useState(initial);
  current = state;
  const onLinkage = (patch: Partial<LinkageDraft>) =>
    setState((value: TransferFormModel) => ({ ...value, linkage: { ...value.linkage!, ...patch } }));
  return h(HrTransferForm, { model: state, mode: 'apply', writable: true, onCancel: () => {}, onLinkage });
}
// 每个用例用新租户：地区字典按租户缓存，避免用例之间共用缓存
async function render(initial: TransferFormModel) {
  const session = { tenantId: randomUUID(), identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () => root.render(h(SessionProvider, { session }, h(Harness, { initial }))));
  await act(async () => {});
}
const salary = () => host.querySelector('#hr-transfer-salary')!;
const outputs = () => Array.from(salary().querySelectorAll('output')).map((item) => item.textContent);
const control = (name: string) => salary().querySelector<HTMLElement>(`[name="${name}"]`);
const select = (name: string) => salary().querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
const options = (name: string) => Array.from(select(name).options).map((item) => item.textContent);
const originCalls = () => calls.filter((call) => call.startsWith('/api/tenant/transfer/insurance-origin'));
const regionCalls = () => calls.filter((call) => call.startsWith('/api/tenant/insurance/regions'));
const click = async (element: Element | null) => {
  await act(async () => (element as HTMLElement).click());
  await act(async () => {});
};
const regionButton = (name: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[data-region-code]')).find((b) => b.textContent === name)!;
async function choose(name: string, value: string) {
  const element = select(name);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {});
}

describe('AC-INS-01 / 02 / 09 薪资调整组的社保原值与调整值', () => {
  it('AC-INS-01 始终 3 对：原值只读、调整值可编辑，6 项都非必填；切换“是否调整薪资”字段不变', async () => {
    await render(model());
    const labels = ['社保缴交地', '社保缴交方案', '社保缴交公司'];
    for (const label of [...labels, ...labels.map((item) => `调整后${item}`)])
      expect(salary().textContent, label).toContain(label);
    expect(Array.from(salary().querySelectorAll('output')).map((item) => item.getAttribute('name'))).toEqual([
      'insuranceRegionCode',
      'insurancePlanId',
      'insuranceCompanyId',
    ]);
    for (const name of ['adjustedInsuranceRegionCode', 'adjustedInsurancePlanId', 'adjustedInsuranceCompanyId'])
      expect((control(name) as HTMLButtonElement | null)?.disabled, name).toBe(false);
    expect(salary().textContent).not.toContain('（必填）');
    expect(salary().querySelectorAll('[required]')).toHaveLength(0);
    expect(salary().textContent).not.toContain('接口暂不支持');
    const count = salary().querySelectorAll('output, select, button').length;
    const yes = host.querySelector<HTMLInputElement>('input[name="adjustSalary"][value="true"]')!;
    await click(yes);
    expect(current.linkage?.adjustSalary).toBe(true);
    expect(salary().querySelectorAll('output, select, button')).toHaveLength(count);
  });

  it('AC-INS-02 原值只取原值接口（不取联动草稿），缴交地取字典名称，方案 / 公司取候选名称', async () => {
    await render(model({ adjustedInsuranceRegionCode: '440103', adjustedInsurancePlanId: PLAN_GZ } as never));
    expect(originCalls()).toEqual([`/api/tenant/transfer/insurance-origin?employeeId=${EMPLOYEE}&effectiveDate=${DATE}`]);
    expect(outputs()).toEqual(['海淀区', '北京基本方案', '合成甲公司']);
    expect(salary().textContent).not.toMatch(UUID_TEXT);
  });

  it('AC-INS-02 没有档案的员工：原值三项显示“--”，调整值仍可填', async () => {
    origin = ok({ regionCode: null, planId: null, companyId: null });
    await render(model());
    expect(outputs()).toEqual(['--', '--', '--']);
    expect((control('adjustedInsuranceRegionCode') as HTMLButtonElement).disabled).toBe(false);
    await choose('adjustedInsuranceCompanyId', COMPANY_NEW);
    expect(current.linkage).toMatchObject({ adjustedInsuranceCompanyId: COMPANY_NEW });
  });

  it.each([
    ['403', fail(403, 'FORBIDDEN')],
    ['404', fail(404, 'NOT_FOUND')],
    ['500', fail(500, 'INTERNAL_ERROR')],
    ['缺键', ok({ regionCode: '110108', planId: PLAN_OLD })],
  ])('AC-INS-09 原值接口 %s：三项都显示“--”，不出现半截原值，不挡表单', async (_name, reply) => {
    origin = reply;
    await render(model());
    expect(outputs()).toEqual(['--', '--', '--']);
    expect(salary().querySelector('[role="alert"]')).toBeNull();
    expect(select('adjustedInsuranceCompanyId').disabled).toBe(false);
    const submit = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === '提交');
    expect(submit?.disabled).toBe(false);
  });

  it('AC-INS-02 带出的暂存单按单号取原值；换人或清除后不再带单号', async () => {
    const parsed = draftRestore.parseDraft(
      DRAFT,
      EMPLOYEE,
      { id: DRAFT, status: 'draft', revision: 2, fields: {}, effectiveDate: DATE },
      { businessId: DRAFT, revision: 2, options: { adjustedInsuranceRegionCode: '110101' } },
      'transfer',
    );
    const restored = draftRestore.restoreDraft(model(), parsed);
    await render(restored);
    expect(originCalls().at(-1)).toBe(
      `/api/tenant/transfer/insurance-origin?employeeId=${EMPLOYEE}&effectiveDate=${DATE}&businessId=${DRAFT}`,
    );
    expect(current.linkage).toMatchObject({ adjustedInsuranceRegionCode: '110101' });
    expect(control('adjustedInsuranceRegionCode')?.textContent).toBe('东城区');
    await act(() => root.unmount());
    root = createRoot(host);
    await render({ ...restored, employeeId: OTHER });
    expect(originCalls().at(-1)).toBe(`/api/tenant/transfer/insurance-origin?employeeId=${OTHER}&effectiveDate=${DATE}`);
    await act(() => root.unmount());
    root = createRoot(host);
    await render(draftRestore.clearDraft(restored));
    expect(originCalls().at(-1)).not.toContain('businessId');
  });
});

describe('AC-INS-03 / 04 调整后缴交地、方案与公司', () => {
  it('AC-INS-03 地区选择器：“全国”页签，按 parent 逐级懒加载，单选，回填只显示末级', async () => {
    origin = ok({ regionCode: null, planId: null, companyId: null });
    await render(model());
    expect(regionCalls()).toEqual([]);
    await click(control('adjustedInsuranceRegionCode'));
    const tabs = () => Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
    expect(tabs()).toEqual(['全国']);
    expect(regionCalls()).toEqual(['/api/tenant/insurance/regions']);
    await click(regionButton('北京市'));
    expect(regionCalls().at(-1)).toBe('/api/tenant/insurance/regions?parent=110000');
    expect(tabs()).toEqual(['全国', '北京市']);
    await click(regionButton('海淀区'));
    expect(current.linkage).toMatchObject({ adjustedInsuranceRegionCode: '110108' });
    expect(host.querySelector('[role="tab"]')).toBeNull();
    expect(control('adjustedInsuranceRegionCode')?.textContent).toBe('海淀区');
    // 地级市有下级则继续下钻；没有下级的（东莞市）直接选中
    await click(control('adjustedInsuranceRegionCode'));
    await click(regionButton('广东省'));
    await click(regionButton('广州市'));
    expect(tabs()).toEqual(['全国', '广东省', '广州市']);
    await click(host.querySelectorAll('[role="tab"]')[1]!);
    await click(regionButton('东莞市'));
    expect(current.linkage).toMatchObject({ adjustedInsuranceRegionCode: '441900' });
    expect(control('adjustedInsuranceRegionCode')?.textContent).toBe('东莞市');
    expect(regionCalls().every((call) => /^\/api\/tenant\/insurance\/regions(\?parent=\d{6})?$/.test(call))).toBe(true);
  });

  it('AC-INS-04 方案按缴交地 + 生效日取候选；未调缴交地时按原缴交地；改缴交地清掉已选方案', async () => {
    await render(model());
    expect(calls).toContain(`/api/tenant/insurance/plans?regionCode=110108&asOf=${DATE}`);
    expect(options('adjustedInsurancePlanId')).toEqual(['—', '北京基本方案', '北京补充方案']);
    await choose('adjustedInsurancePlanId', PLAN_NEW);
    expect(current.linkage).toMatchObject({ adjustedInsurancePlanId: PLAN_NEW });
    await click(control('adjustedInsuranceRegionCode'));
    await click(regionButton('广东省'));
    await click(regionButton('广州市'));
    await click(regionButton('荔湾区'));
    expect(calls).toContain(`/api/tenant/insurance/plans?regionCode=440103&asOf=${DATE}`);
    expect(current.linkage).toMatchObject({ adjustedInsuranceRegionCode: '440103', adjustedInsurancePlanId: '' });
    // 被字段权限去掉 planId 的方案不能作为候选
    expect(options('adjustedInsurancePlanId')).toEqual(['—', '广州方案']);
    expect(options('adjustedInsuranceCompanyId')).toEqual(['—', '合成甲公司', '合成乙公司']);
  });

  it('AC-INS-04 没有候选（含无权读取）时显示“暂无可选项”，不报错；已存值不在候选里时不悄悄换掉', async () => {
    plans = () => fail(403, 'FORBIDDEN');
    companies = ok({ items: [] });
    await render(model({ adjustedInsuranceCompanyId: COMPANY_OLD } as never));
    expect(options('adjustedInsurancePlanId')).toEqual(['暂无可选项']);
    expect(select('adjustedInsuranceCompanyId').value).toBe(COMPANY_OLD);
    expect(options('adjustedInsuranceCompanyId')).toEqual(['暂无可选项', '已保存的值']);
    expect(salary().querySelector('[role="alert"]')).toBeNull();
  });

  it('AC-INS-03 / 04 保存时的字典校验拒绝走既有错误显示（服务端原因原样显示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const details = { reason: 'INSURANCE_REGION_INVALID' };
        const error = { code: 'VALIDATION_FAILED', message: '缴交地不在行政区划字典内', details };
        return new Response(JSON.stringify({ error }), { status: 400 });
      }),
    );
    await expect(transferRequest(randomUUID(), '/api/tenant/employment/transfers', { method: 'POST' })).rejects.toThrow(
      '缴交地不在行政区划字典内',
    );
  });
});

describe('F-474-8c-3 联动草稿：载荷、暂存还原与联动详情', () => {
  const filled = {
    adjustedInsuranceRegionCode: '110108',
    adjustedInsurancePlanId: PLAN_NEW,
    adjustedInsuranceCompanyId: '',
  };
  it('提交载荷只带填了的调整值；都没填时不带社保键', () => {
    const body = transferBody(model(filled as never), 'submit');
    expect(body.linkage).toEqual({ adjustedInsuranceRegionCode: '110108', adjustedInsurancePlanId: PLAN_NEW });
    expect(transferBody(model(), 'submit')).not.toHaveProperty('linkage');
  });

  it('暂存还原三个调整值；只带出当前可编辑的项', () => {
    const options = { adjustedInsuranceRegionCode: '110108', adjustedInsurancePlanId: PLAN_NEW };
    expect(draftRestore.linkageFromOptions(options)).toEqual({ ...emptyLinkage, ...options });
    const editable = { ...catalog, editableFields: ['adjustedInsurancePlanId'] };
    expect(draftRestore.editableLinkage(editable, { ...emptyLinkage, ...options })).toEqual({
      ...emptyLinkage,
      adjustedInsurancePlanId: PLAN_NEW,
    });
  });

  it('联动详情列出社保档案子项：状态、失败原因与重试入口', async () => {
    const insuranceArchive = {
      id: 'item-insurance',
      revision: 2,
      itemType: 'insurance_archive',
      subordinateId: null,
      orgId: null,
      orgRole: null,
      relation: null,
      receiverId: null,
      partTimeRecordId: null,
      effectiveDate: DATE,
      status: 'failed',
      attemptCount: 1,
      lastAttemptAt: '2026-11-20T01:00:00.000Z',
      failure: { code: 'VALIDATION_FAILED', message: '社保方案在生效日当月不可用', rule: null },
    };
    const view = {
      businessId: DRAFT,
      revision: 4,
      executedAt: '2026-11-20T01:00:00.000Z',
      options: {},
      contract: null,
      onTrial: null,
      handover: null,
      dutyTransfer: null,
      partTimes: [],
      insuranceArchive,
      salaryReminder: null,
    } as unknown as LinkageView;
    await act(async () => root.render(h(LinkagePanel, { view })));
    expect(host.textContent).toContain('社保档案');
    expect(host.textContent).toContain('社保方案在生效日当月不可用');
    expect(host.querySelector('[data-retry-item="item-insurance"]')).not.toBeNull();
  });
});
