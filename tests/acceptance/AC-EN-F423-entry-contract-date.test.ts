/**
 * F-423 入职正式合同按入职日生成（DEC-735 收窄；DEC-402 不留兼容）：
 * ④ 办理入职带合同信息时，合同生效日固定取入职日；请求里的 contract.effectiveDate 一律 400（字段不允许），
 *    同类入口（新增实习生 = 入职日、退休同时返聘 = 返聘日 R）同样不接受请求覆盖。
 * ② 锁定回归（不要求先红，现状已与 F-434 取证一致）：北森合同区全空时办理入职照样成功，不生成任何合同，
 *    待入职合同也不转正式；复刻清掉待入职合同、留一条 employment.entry.contract_release（reason=complete），
 *    员工出现在合同列表「入职缺失」视图（docs/02_业务建模/34 末尾「补充：F-434」）。
 * 测试时钟 2026-10-01；业务日期、公司、类型都是合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addPending, entryAction, entryRecords, entryWorld, type EntryWorld } from './AC-EN-BE2a-support.js';
import { createWorld } from './AC-IN-BE-R2d4c-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');
const RELEASE = 'employment.entry.contract_release';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

async function contractWorld(label: string) {
  const w = await entryWorld(testDb().db, `${label}-${uniqueSuffix()}`);
  const api = tenantApi(w.db, { clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await api.request('POST', `/api/tenant/contracts/master-data/${kind}`, {
      ...as,
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const typeId = await master('types', '劳动合同');
  const companyId = await master('companies', '合成法人公司');
  const contract = { typeId, companyId, termType: 'fixed', termMonths: 12, endDate: '2027-08-31' };
  async function contracts(view = 'all') {
    const response = await api.request('GET', `/api/tenant/contracts?view=${view}`, as);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: { employeeId: string; effectiveDate?: string }[] }).items;
  }
  return { w, companyId, contract, contracts };
}

async function pendingContracts(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ businessId: string }>(
      await tx.execute(sql`SELECT business_id AS "businessId" FROM employment_pending_entry_contract
        WHERE tenant_id=${w.session.tenant.id}`),
    ),
  );
}

/** 待入职合同的法人公司（Offer 同步才有值；这里直接写表模拟北森“待入职合同带公司”的现场）。 */
async function setPendingCompany(w: EntryWorld, businessId: string, companyId: string) {
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    await tx.execute(sql`UPDATE employment_pending_entry_contract SET contract_company_id=${companyId}::uuid
      WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid`);
  });
}

async function releaseEvents(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{
      objectId: string;
      commandId: string | null;
      payload: { before: unknown; after: unknown; meta?: { reason?: string } };
    }>(
      await tx.execute(sql`SELECT object_id AS "objectId", command_id AS "commandId", payload FROM employment_outbox
        WHERE tenant_id=${w.session.tenant.id} AND event_type=${RELEASE} ORDER BY created_at, id`),
    ),
  );
}

/** 统一审计表（audit_events，DEC-019）里的待入职合同清理记录；reason 只在 outbox 的 meta 里（审计表无 meta 列）。 */
async function releaseAudits(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ objectType: string; objectId: string; before: unknown; after: unknown; commandId: string | null }>(
      await tx.execute(sql`SELECT object_type AS "objectType", object_id AS "objectId", before, after,
        command_id AS "commandId" FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action=${RELEASE} ORDER BY occurred_at, id`),
    ),
  );
}

describe('F-423 ④ 办理入职的合同生效日固定取入职日', () => {
  it('不带 effectiveDate：合同生效日 = 入职日', async () => {
    const { w, contract, contracts } = await contractWorld('f423-default');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const response = await entryAction(w, recordId, 'complete', { probation: false, contract });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await contracts()).toMatchObject([{ employeeId: employee.id, effectiveDate: '2026-09-01' }]);
  });

  it.each([
    ['与入职日不同', '2026-09-05'],
    ['与入职日相同（字段本身不允许，不看取值）', '2026-09-01'],
  ])('带 contract.effectiveDate（%s）→ 400，待入职不变、不生成合同', async (_name, effectiveDate) => {
    const { w, contract, contracts } = await contractWorld('f423-reject');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const response = await entryAction(w, recordId, 'complete', {
      probation: false,
      contract: { ...contract, effectiveDate },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 1 });
    expect(await contracts()).toEqual([]);
    expect(await pendingContracts(w)).toMatchObject([{ businessId: recordId }]);
  });

  it('同类入口：新增实习生的合同带 effectiveDate → 400（起始日 = 入职日，不接受请求覆盖）', async () => {
    const c = await createWorld(testDb().db, `f423-intern-${uniqueSuffix()}`);
    const contract = { typeId: c.typeId, companyId: c.companyId, termType: 'fixed', endDate: '2027-09-30' };
    const body = c.hireBody({ contract: { ...contract, effectiveDate: '2026-10-05' } });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
  });
});

describe('F-423 ② 锁定回归：合同区全空办理入职（F-434）', () => {
  it('有待入职合同、不带合同字段 → 成功；清掉待入职合同、不生成正式合同、留一条清理审计；进「入职缺失」', async () => {
    const { w, companyId, contract, contracts } = await contractWorld('f423-empty');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    // 对照人：同日入职、带合同办理。「入职缺失」不按待入职状态过滤（contracts/queries.ts，范围外），
    // 两人入职前都已在列，所以“前无后有”不成立；改用入职后的对照：带合同的出列、全空的留在列里。
    const control = await addPending(w, '2026-09-01');
    const missing = async () => (await contracts('missing')).map((item) => item.employeeId);
    expect(await missing()).toEqual(expect.arrayContaining([employee.id, control.employee.id]));
    const signed = await entryAction(w, control.recordId, 'complete', { probation: false, contract });
    expect(signed.status, await signed.clone().text()).toBe(200);
    await setPendingCompany(w, recordId, companyId);
    expect(await pendingContracts(w)).toHaveLength(1);

    const response = await entryAction(w, recordId, 'complete', { probation: false });
    expect(response.status, await response.clone().text()).toBe(200);

    // 不带试用期 → 正式（EMPLOYEE_STATUS.regular = 3）
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 3 });
    expect(await pendingContracts(w)).toEqual([]);
    expect((await contracts()).map((item) => item.employeeId)).toEqual([control.employee.id]);
    const released = (await releaseEvents(w)).filter((event) => event.objectId === recordId);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      objectId: recordId,
      payload: {
        before: { contractStartDate: '2026-09-01', contractEndDate: null, contractCompanyId: companyId },
        after: null,
        meta: { reason: 'complete' },
      },
    });
    expect(await missing()).toContain(employee.id);
    expect(await missing()).not.toContain(control.employee.id);
    // 统一审计表：同一条命令写一条，与 outbox 事件同事务（command_id 相同），前值留快照、后值为空
    const before = { contractStartDate: '2026-09-01', contractEndDate: null, contractCompanyId: companyId };
    const audits = (await releaseAudits(w)).filter((audit) => audit.objectId === recordId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ objectType: 'employment-business', objectId: recordId, before, after: null });
    expect(audits[0]!.commandId).toBeTruthy();
    expect(released[0]!.commandId).toBe(audits[0]!.commandId);
  });
});
