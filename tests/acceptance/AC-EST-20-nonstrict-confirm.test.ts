/**
 * AC-EST-20（F-026，F-024 R1 OBS-03，AC-EST-02）：重叠调入超编时，严格控编拒绝，非严格控编先提示确认。
 * 容量 1，两个人调入同一部门，生效日 10-20 与 10-05 重叠：不论保存顺序，第二笔保存都使峰值达到 2 人。
 * 期望值全部手写：
 * - 严格控编：409 ESTABLISHMENT_EXCEEDED，第二人没有新增任职记录；
 * - 非严格控编：未带 confirmed 返回 409 CONFIRMATION_REQUIRED（整单回滚，没有新增记录），
 *   带 confirmed 以新命令重提返回 201，新增一条任职记录。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

async function fixture(label: string, strictControl: boolean, on: 'to' | 'from' = 'to') {
  const w = await activationWorld(database().db, label);
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const request = (method: string, path: string, body: object) =>
    api.request(method, `/api/tenant/establishment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body,
    });
  const scheme = await request('POST', '/schemes', {
    name: '合成控编方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [{ employmentType: 'internal' }],
  });
  expect(scheme.status).toBe(201);
  const capacity = await request('POST', '/capacities', {
    orgId: w[on].id,
    schemeId: ((await scheme.json()) as { id: string }).id,
    periodStart: '2026-01-01',
    localCapacity: 1,
    strictControl,
  });
  expect(capacity.status).toBe(201);
  return w;
}
type World = Awaited<ReturnType<typeof fixture>>;
type Person = Awaited<ReturnType<World['hired']>>;

const transfer = (w: World, person: Person, date: string, extra: Record<string, unknown> = {}) =>
  w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
    ifMatch: person.hire.employeeRevision,
    body: {
      initiator: 'hr',
      transferTypeCode: 'cross_department',
      mode: 'direct',
      effectiveDate: date,
      fields: { departmentId: w.to.id },
      ...extra,
    },
  });
const recordCount = async (w: World, person: Person) =>
  (await w.session.records(person.employee.id, '2026-12-31')).length;

const ORDERS = [
  { name: '先存 10-20 再存 10-05', first: '2026-10-20', second: '2026-10-05' },
  { name: '先存 10-05 再存 10-20', first: '2026-10-05', second: '2026-10-20' },
] as const;

describe('AC-EST-20 重叠调入超编：严格拒绝 / 非严格确认', () => {
  it.each(ORDERS)('严格控编 · $name：第二笔 409 ESTABLISHMENT_EXCEEDED，不落记录', async (order) => {
    const w = await fixture(`est20-strict-${order.first}`, true);
    const first = await w.hired('先存');
    const second = await w.hired('后存');
    expect((await transfer(w, first, order.first)).status).toBe(201);
    const blocked = await transfer(w, second, order.second);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await recordCount(w, second)).toBe(1);
  });

  it.each(ORDERS)('严格控编 · $name：带 confirmed 也不能放行', async (order) => {
    const w = await fixture(`est20-strict-forced-${order.first}`, true);
    const first = await w.hired('先存');
    const second = await w.hired('后存');
    expect((await transfer(w, first, order.first)).status).toBe(201);
    const forced = await transfer(w, second, order.second, { confirmed: true });
    expect(forced.status).toBe(409);
    expect(await forced.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await recordCount(w, second)).toBe(1);
  });

  it.each(ORDERS)('非严格控编 · $name：未确认 409 且不落记录，确认后 201', async (order) => {
    const w = await fixture(`est20-loose-${order.first}`, false);
    const first = await w.hired('先存');
    const second = await w.hired('后存');
    // 第一笔未超编，直接成功，不要求确认
    expect((await transfer(w, first, order.first)).status).toBe(201);
    const unconfirmed = await transfer(w, second, order.second);
    expect(unconfirmed.status, await unconfirmed.clone().text()).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      error: {
        details: {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ departmentId: w.to.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
        },
      },
    });
    expect(await recordCount(w, second)).toBe(1);
    const confirmed = await transfer(w, second, order.second, { confirmed: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(201);
    expect(await recordCount(w, second)).toBe(2);
  });

  describe('其他交互保存入口（非严格控编）', () => {
    const CONFIRM = { error: { details: { reason: 'CONFIRMATION_REQUIRED' } } };
    const create = (w: World, person: Person, body: Record<string, unknown>) =>
      w.session.request('POST', `/employees/${person.employee.id}/businesses`, {
        ifMatch: person.hire.employeeRevision,
        body: { kind: 'transfer', fields: { departmentId: w.to.id }, ...body },
      });
    /** 第一人 10-20 先占满容量 1。 */
    async function occupied(label: string) {
      const w = await fixture(label, false);
      const first = await w.hired('先占编');
      expect((await transfer(w, first, '2026-10-20')).status).toBe(201);
      return { w, second: await w.hired('后存') };
    }

    it('业务创建（直接）：未确认 409 且不落记录，带 confirmed 后 201', async () => {
      const { w, second } = await occupied('est20-create');
      const body = { mode: 'direct', effectiveDate: '2026-10-05' };
      const unconfirmed = await create(w, second, body);
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject(CONFIRM);
      expect(await recordCount(w, second)).toBe(1);
      expect((await create(w, second, { ...body, confirmed: true })).status).toBe(201);
      expect(await recordCount(w, second)).toBe(2);
    });

    it('业务创建（草稿）：未确认 409，带 confirmed 后存为草稿', async () => {
      const { w, second } = await occupied('est20-draft');
      const body = { mode: 'application', effectiveDate: '2026-10-05' };
      expect((await create(w, second, body)).status).toBe(409);
      const saved = await create(w, second, { ...body, confirmed: true });
      expect(saved.status).toBe(201);
      expect(await saved.json()).toMatchObject({ status: 'draft' });
    });

    it('提交：草稿保存后容量被占满，提交未确认 409，带 confirmed 后进入审批', async () => {
      const w = await fixture('est20-submit', false);
      const second = await w.hired('后存');
      const draft = await w.session.business(
        second.employee.id,
        { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        second.hire.employeeRevision,
      );
      const first = await w.hired('先占编');
      expect((await transfer(w, first, '2026-10-20')).status).toBe(201);
      const submit = (extra: object) =>
        w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: extra });
      const unconfirmed = await submit({});
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject(CONFIRM);
      expect((await w.session.request('GET', `/businesses/${draft.id}`)).status).toBe(200);
      const confirmed = await submit({ confirmed: true });
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      expect(await confirmed.json()).toMatchObject({ status: 'in_review' });
      // 审批通过不再弹确认：落地走严格兜底，非严格超编照常通过
      const approved = await w.approve(draft, '2026-10-02T01:00:00.000Z');
      expect(approved.status).toBe('approved');
    });

    it('任职记录编辑：把记录改到已占满的部门，未确认 409，带 confirmed 后 200', async () => {
      const { w, second } = await occupied('est20-edit');
      const [record] = await w.session.records(second.employee.id, '2026-10-01');
      const edit = (extra: object) =>
        w.session.request('PATCH', `/records/${record!.id}`, {
          ifMatch: record!.revision,
          body: { fields: { departmentId: w.to.id }, ...extra },
        });
      const unconfirmed = await edit({});
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject(CONFIRM);
      const confirmed = await edit({ confirmed: true });
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    });

    it('删除恢复：删除调出记录后恢复回已占满的原部门，未确认 409，带 confirmed 后 200', async () => {
      const w = await fixture('est20-restore', false, 'from');
      const mover = await w.hired('调出者');
      const stayer = await w.hired('留任者');
      expect(stayer.employee.id).not.toBe(mover.employee.id);
      const moved = await w.session.business(
        mover.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        mover.hire.employeeRevision,
      );
      const remove = (body?: object) =>
        w.session.request('DELETE', `/businesses/${moved.id}`, { ifMatch: moved.revision, ...(body ? { body } : {}) });
      const unconfirmed = await remove();
      expect(unconfirmed.status, await unconfirmed.clone().text()).toBe(409);
      expect(await unconfirmed.json()).toMatchObject(CONFIRM);
      const confirmed = await remove({ confirmed: true });
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    });
  });
});
