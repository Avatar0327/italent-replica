import './support/exit-gate-enforced.js';
import { CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DAY = '2026-10-25';
const BASE_FIELDS = ['id', 'employeeId', 'status', 'revision', 'reEmployed'];

async function world(label: string) {
  const db = database().db;
  const x = withRehire(db, await retirementCancelWorld(db, label, TODAY), TODAY);
  type Request = typeof x.session.request;

  async function detail(id: string, request: Request = x.session.request, query = '') {
    const response = await request('GET', `/retirements/${id}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function list(view: string, request: Request = x.session.request) {
    const response = await request('GET', `/retirements?view=${view}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: Record<string, unknown>[]; total: number };
  }

  const restore = (id: string, request: Request = x.session.request) =>
    request('POST', `/retirements/${id}/restore`, { ifMatch: 1, body: {} });

  return { ...x, detail, list, restore };
}

describe('AC-RT-F535 退休逐单恢复动作', () => {
  it('有权用户在已撤销详情及 view=cancelled 看到 restore，调用仍返回 409', async () => {
    const x = await world('rt-f535-restore');
    const retired = await x.directRetire(LAST_WORK_DAY);
    await x.retireCancelled(retired.id);
    const request = x.restricted(denyButtons('Employment.DimissionCancel'));

    expect(await x.reason(await x.restore(retired.id, request))).toMatchObject({
      status: 409,
      reason: 'EXIT_RESTORE_NOT_SUPPORTED',
    });
    expect(await x.stateOfBusiness(retired.id)).toBe('voided');
    const detail = await x.detail(retired.id, request);
    const cancelledDetail = await x.detail(retired.id, request, '?view=cancelled');
    const cancelled = await x.list('cancelled', request);
    const all = await x.list('all', request);
    expect.soft(detail.actions).toEqual(['restore']);
    expect.soft(cancelledDetail.actions).toEqual(['restore']);
    expect.soft(cancelled.items.find((item) => item.id === retired.id)?.actions).toEqual(['restore']);
    expect.soft(all.items.find((item) => item.id === retired.id)?.actions).toEqual(['restore']);
  });

  it('按钮、对象更新权、数据范围、状态查看权和已撤销事实分别限制 restore', async () => {
    const x = await world('rt-f535-restore-gates');
    const retired = await x.directRetire(LAST_WORK_DAY);
    const second = await x.newcomer('未撤销退休员工');
    const active = await x.directRetire(LAST_WORK_DAY, undefined, second.id);
    await x.retireCancelled(retired.id);
    const noButton = x.restricted(denyButtons('Employment.RetireCancel'));
    const noUpdate = x.restricted((request) => request.action !== 'object.update');
    const noScope = x.restricted(denyButtons(), (await x.otherUser()).id);
    const noStatus = x.restricted(denyButtons(), undefined, ['id', 'employeeId', 'revision']);

    for (const request of [noButton, noUpdate, noStatus]) {
      expect((await x.detail(retired.id, request)).actions ?? []).not.toContain('restore');
      const page = await x.list('cancelled', request);
      expect(page.total).toBe(1);
      expect(page.items[0]?.actions ?? []).not.toContain('restore');
    }
    expect((await x.restore(retired.id, noButton)).status).toBe(403);
    expect((await x.restore(retired.id, noUpdate)).status).toBe(403);
    expect((await noScope('GET', `/retirements/${retired.id}`)).status).toBe(404);
    expect(await x.list('cancelled', noScope)).toMatchObject({ items: [], total: 0 });
    expect((await x.restore(retired.id, noScope)).status).toBe(404);

    expect((await x.detail(active.id)).actions ?? []).not.toContain('restore');
    const activeRow = (await x.list('all')).items.find((item) => item.id === active.id);
    expect(activeRow).toBeDefined();
    expect(activeRow?.actions ?? []).not.toContain('restore');
  });
});

describe('AC-RT-F535 本单返聘计划回读', () => {
  it('详情按本单读取已保存计划，列表不披露返聘计划', async () => {
    const x = await world('rt-f535-rehire');
    const contract = x.contractPlan(await x.contractMaster());
    const plan = x.rehirePlan({ contract, entry: { probation: true, probationMonths: 2 } });
    const retired = await x.createdRehire(x.rehireBody(LAST_WORK_DAY, 'direct', plan));
    const second = await x.newcomer('第二份返聘计划');
    const secondPlan = x.rehirePlan({ fields: { remarks: '第二单独立计划' } });
    const other = await x.createdRehire(x.rehireBody(LAST_WORK_DAY, 'direct', secondPlan), second.id);

    const expected = { ...plan, contract, formId: 'standard', customFields: {} };
    expect((await x.extension(retired.id))?.rehire_plan).toEqual(expected);
    const detail = await x.detail(retired.id);
    expect(detail.reEmployed).toBe(true);
    expect.soft(detail.rehire).toEqual(expected);
    expect.soft((await x.detail(other.id)).rehire).toEqual({ ...secondPlan, formId: 'standard', customFields: {} });
    const row = (await x.list('all')).items.find((item) => item.id === retired.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('rehire');
  });

  it('按任职与合同字段权裁剪返聘计划，隐藏整体及范围外计划', async () => {
    const x = await world('rt-f535-rehire-fields');
    const contract = x.contractPlan(await x.contractMaster(), { probationSalary: '12345.67' });
    const plan = x.rehirePlan({
      contract,
      fields: { remarks: '只给授权字段读者' },
      entry: { probation: true, probationMonths: 2 },
    });
    const retired = await x.createdRehire(x.rehireBody(LAST_WORK_DAY, 'direct', plan));
    const fields = [...BASE_FIELDS, 'departmentId', 'probationMonths', 'companyId'];
    const partial = x.restricted(denyButtons(), undefined, fields);
    const noContract = x.restricted(
      (request) => !(request.action === 'object.view' && request.resource === CONTRACT_OBJECT),
      undefined,
      fields,
    );
    const noFlag = x.restricted(
      denyButtons(),
      undefined,
      fields.filter((field) => field !== 'reEmployed'),
    );
    const noScope = x.restricted(denyButtons(), (await x.otherUser()).id, fields);

    expect.soft((await x.detail(retired.id, partial)).rehire).toEqual({
      fields: { departmentId: x.to.id },
      customFields: {},
      entry: { probationMonths: 2 },
      contract: { companyId: contract.companyId },
    });
    const withoutContract = await x.detail(retired.id, noContract);
    expect.soft(withoutContract).toHaveProperty('rehire.fields.departmentId', x.to.id);
    expect(withoutContract).not.toHaveProperty('rehire.contract');
    expect(await x.detail(retired.id, noFlag)).not.toHaveProperty('rehire');
    const outside = await noScope('GET', `/retirements/${retired.id}`);
    expect(outside.status).toBe(404);
    expect(await outside.text()).not.toContain('只给授权字段读者');
  });

  it('不同时返聘时，有字段权的详情明确回传 rehire: null', async () => {
    const x = await world('rt-f535-rehire-empty');
    const retired = await x.directRetire(LAST_WORK_DAY);
    const allowed = x.restricted(denyButtons(), undefined, BASE_FIELDS);
    const hidden = x.restricted(denyButtons(), undefined, ['id', 'employeeId']);
    expect.soft(await x.detail(retired.id, allowed)).toMatchObject({ reEmployed: false, rehire: null });
    expect(await x.detail(retired.id, hidden)).not.toHaveProperty('rehire');
  });
});
