/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-8c-3 AC-INS-08（设计 F-474-8b §5）：审批详情只列有变化的社保调整项，新值高亮，下方灰字“原：旧值”；
 * 没调整就没有“薪资调整”组；“原”只在后端下发 insuranceOrigin.* 时显示（披露由后端裁剪，前端不判权限）。
 * 载荷形状按 linkage/approval.ts：调整值只在非空时下发，insuranceOrigin.* 为原始值（可能为 null）。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const PLAN_OLD = '82000000-0000-4000-8000-000000000001';
const PLAN_NEW = '82000000-0000-4000-8000-000000000002';
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const region = (code: string, parentCode: string | null, level: number, name: string) => ({
  code,
  parentCode,
  level,
  name,
});
const REGIONS: Record<string, unknown[]> = {
  '': [region('110000', null, 1, '北京市'), region('440000', null, 1, '广东省')],
  '110000': [region('110108', '110000', 3, '海淀区')],
  '440000': [region('440100', '440000', 2, '广州市')],
  '440100': [region('440103', '440100', 3, '荔湾区')],
};
type Values = Record<string, unknown>;
const transfer = (values: Values) => ({
  id: 'instance-1',
  title: '合成员工的调动申请',
  status: 'running',
  approvalType: 'transfer',
  revision: 3,
  createdAt: '2026-11-02T01:00:00Z',
  actions: [],
  recordsHidden: false,
  commentNotice: '合成提示',
  form: {
    values: { effectiveDate: '2026-11-20', adjustSalary: false, isChangeContract: false, ...values },
    // 后端 form.originals 只有任职字段，没有社保键（原值走 insuranceOrigin.*）
    originals: {},
  },
  tasks: [{ id: 'task-1', nodeName: '部门负责人审批', status: 'pending' }],
  logs: [],
});
const adjusted = {
  adjustedInsuranceRegionCode: '110108',
  adjustedInsurancePlanId: PLAN_NEW,
  'insuranceOrigin.regionCode': '440103',
  'insuranceOrigin.planId': PLAN_OLD,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function render(detail: ReturnType<typeof transfer>, flags: Record<string, boolean> = { applications: true }) {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://local');
    if (url.pathname === '/api/tenant/insurance/regions')
      return new Response(JSON.stringify({ items: REGIONS[url.searchParams.get('parent') ?? ''] ?? [] }));
    if (url.pathname.endsWith('/logs'))
      return new Response(JSON.stringify({ items: [], recordsHidden: false, page: 1, pageSize: 20 }));
    return new Response(JSON.stringify(detail));
  });
  vi.stubGlobal('fetch', fetcher);
  const session = { tenantId: randomUUID(), identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  const row = { id: detail.id, title: detail.title, approvalType: detail.approvalType, status: detail.status };
  const page = h(ApprovalDetail, { row, layout: 'page', onClose: () => {}, onChanged: () => {}, ...flags });
  await act(async () => root.render(h(SessionProvider, { session }, h(MemoryRouter, { initialEntries: ['/'] }, page))));
  await act(async () => {});
  await act(async () => {});
}
const group = (title: string) =>
  Array.from(host.querySelectorAll('.approval-field-group')).find(
    (item) => item.querySelector('h3')?.textContent === title,
  );
const field = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('.approval-field')).find((item) => item.querySelector('dt')?.textContent === label);

describe('AC-INS-08 审批详情的社保调整', () => {
  it('“薪资调整”组只列填了的调整项：新值高亮、缴交地取字典名称，下方灰字“原：旧值”', async () => {
    await render(transfer(adjusted));
    const salary = group('薪资调整')!;
    expect(Array.from(salary.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual([
      '调整后社保缴交地',
      '调整后社保缴交方案',
    ]);
    const place = field(salary, '调整后社保缴交地')!;
    expect(place.querySelector('dd')?.classList.contains('approval-changed')).toBe(true);
    expect(place.querySelector('dd span')?.textContent).toBe('海淀区');
    expect(place.querySelector('small')?.textContent).toBe('原：荔湾区');
    const scheme = field(salary, '调整后社保缴交方案')!;
    expect(scheme.querySelector('dd')?.classList.contains('approval-changed')).toBe(true);
    expect(scheme.querySelector('small')?.textContent).toMatch(/^原：/);
    // 原值随调整项展示，不单独成行；不出现裸 ID 与内部键名
    const text = host.textContent ?? '';
    expect(text).not.toMatch(UUID_TEXT);
    expect(text).not.toContain('insuranceOrigin');
    expect(text).not.toContain('adjustedInsurance');
  });

  it('后端未下发 insuranceOrigin.*（无社保档案查看权）时不写“原”；下发 null（无档案）时写“原：—”', async () => {
    const { 'insuranceOrigin.regionCode': _hidden, ...trimmed } = adjusted;
    await render(transfer({ ...trimmed, 'insuranceOrigin.planId': null }));
    const salary = group('薪资调整')!;
    const place = field(salary, '调整后社保缴交地')!;
    expect(place.querySelector('dd')?.classList.contains('approval-changed')).toBe(true);
    expect(place.querySelector('small')).toBeNull();
    expect(field(salary, '调整后社保缴交方案')!.querySelector('small')?.textContent).toBe('原：—');
  });

  it('没有调整社保时没有“薪资调整”组', async () => {
    await render(transfer({}));
    expect(group('调动信息')).toBeDefined();
    expect(group('薪资调整')).toBeUndefined();
  });

  it('待办入口平铺呈现同样按名称显示并写“原”，不出现原值键行', async () => {
    await render(transfer(adjusted), { todo: true });
    const place = field(host, '调整后社保缴交地')!;
    expect(place.querySelector('dd span')?.textContent).toBe('海淀区');
    expect(place.querySelector('small')?.textContent).toBe('原：荔湾区');
    expect(host.textContent).not.toContain('insuranceOrigin');
    expect(host.textContent).not.toMatch(UUID_TEXT);
  });
});
