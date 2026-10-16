/**
 * F-194 待入职劳动合同与改期联动（DEC-550，R2e9 §5 / §7.5；后端）：
 * 进入待入职时生成一份“待入职合同”（起始日 = 计划入职日期，终止日为空），挂在待入职记录上，不进正式合同列表；
 * 改期入职（含已取消恢复）同步改合同起始日并在响应里给 contractNotice；行内编辑不联动、不提示；
 * 办理入职沿用原流程生成正式合同（正好一份 / 不带合同信息则没有），待入职合同不再留存；删除待入职一并清理。
 * 测试时钟 2026-10-01；业务日期都是合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryWorld,
  hireBody,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');
const POSTPONED = 2;
const NORMAL = 0;

interface ViewItem {
  readonly id: string;
  readonly effectiveDate: string;
  readonly entryStatus: number | null;
  readonly contractStartDate: string | null;
  readonly contractEndDate: string | null;
}

async function view(w: EntryWorld, name = 'all'): Promise<ViewItem[]> {
  const response = await w.session.request('GET', `/pending-entries?view=${name}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ViewItem[] }).items;
}

/** 正式合同列表（合同模块）：待入职合同不得出现在这里。 */
async function formalContracts(w: EntryWorld) {
  const response = await tenantApi(w.db, { clock }).request('GET', '/api/tenant/contracts?view=all', {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Record<string, unknown>[] }).items;
}

const TABLE = 'employment_pending_entry_contract';

/** 待入职合同存放表的行；表要存在（旧实现下这里按“表不存在”判红，不是导入错误）。 */
async function pendingContractRows(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const exists = rowsOf<{ regclass: string | null }>(await tx.execute(sql`SELECT to_regclass(${TABLE}) AS regclass`));
    expect(exists[0]?.regclass, '待入职合同表应已建立').not.toBeNull();
    return rowsOf<{ businessId: string; startDate: string; endDate: string | null }>(
      await tx.execute(sql`SELECT business_id AS "businessId", start_date::text AS "startDate",
        end_date::text AS "endDate" FROM employment_pending_entry_contract
        WHERE tenant_id=${w.session.tenant.id} ORDER BY start_date, business_id`),
    );
  });
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

async function auditRows(w: EntryWorld, action: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ objectId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      await tx.execute(sql`SELECT object_id AS "objectId", before, after FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action=${action} ORDER BY occurred_at, id`),
    ),
  );
}

async function postpone(w: EntryWorld, recordId: string, effectiveDate: string) {
  const response = await entryAction(w, recordId, 'postpone', { effectiveDate });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function cancel(w: EntryWorld, recordId: string) {
  const response = await entryAction(w, recordId, 'cancel', {});
  expect(response.status, await response.clone().text()).toBe(200);
}

async function contractWorld(label: string) {
  const w = await entryWorld(testDb().db, label);
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
  return { w, contract: { typeId, companyId, termType: 'fixed', termMonths: 12, endDate: '2027-10-31' } };
}

describe('F-194 进入待入职时生成待入职合同', () => {
  it('添加待入职：列表合同起始日 = 计划入职日期、终止日为空；正式合同列表查不到；创建审计带合同起始日', async () => {
    const w = await entryWorld(testDb().db, 'f194-add');
    const { recordId } = await addPending(w, '2026-10-17');
    expect(await view(w)).toMatchObject([
      { id: recordId, effectiveDate: '2026-10-17', contractStartDate: '2026-10-17', contractEndDate: null },
    ]);
    expect(await pendingContractRows(w)).toMatchObject([
      { businessId: recordId, startDate: '2026-10-17', endDate: null },
    ]);
    expect(await formalContracts(w)).toEqual([]);
    expect(await auditRows(w, 'employment.business.create')).toMatchObject([
      { after: { contractStartDate: '2026-10-17', contractEndDate: null } },
    ]);
  });

  it('同一员工不会重复生成：每条待入职记录正好一份合同', async () => {
    const w = await entryWorld(testDb().db, 'f194-once');
    await addPending(w, '2026-10-10', '甲');
    await addPending(w, '2026-10-12', '乙');
    expect((await pendingContractRows(w)).map((row) => row.startDate)).toEqual(['2026-10-10', '2026-10-12']);
  });
});

describe('F-194 改期入职联动合同', () => {
  it('改期 18→19：合同起始日同步改为 19，响应 contractNotice，状态延期，审计有前后值', async () => {
    const w = await entryWorld(testDb().db, 'f194-postpone');
    const { recordId } = await addPending(w, '2026-10-18');
    const body = await postpone(w, recordId, '2026-10-19');
    expect(body.contractNotice).toEqual({ startDate: '2026-10-19', endDate: null });
    expect(await view(w)).toMatchObject([
      { effectiveDate: '2026-10-19', entryStatus: POSTPONED, contractStartDate: '2026-10-19', contractEndDate: null },
    ]);
    // 记录被替换：合同只剩新记录上的一份
    const rows = await pendingContractRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startDate: '2026-10-19', endDate: null });
    expect(rows[0]!.businessId).not.toBe(recordId);
    expect(await auditRows(w, 'employment.entry.postpone')).toMatchObject([
      {
        before: { contractStartDate: '2026-10-18', contractEndDate: null },
        after: { contractStartDate: '2026-10-19', contractEndDate: null },
      },
    ]);
    expect(await formalContracts(w)).toEqual([]);
  });

  it('已取消人员改期恢复 17→18：取消时合同保留，恢复后合同起始日改为 18，状态延期', async () => {
    const w = await entryWorld(testDb().db, 'f194-restore');
    const { recordId } = await addPending(w, '2026-10-17');
    await cancel(w, recordId);
    expect(await view(w, 'cancelled')).toMatchObject([{ contractStartDate: '2026-10-17', contractEndDate: null }]);
    const body = await postpone(w, recordId, '2026-10-18');
    expect(body.contractNotice).toEqual({ startDate: '2026-10-18', endDate: null });
    expect(await view(w, 'cancelled')).toEqual([]);
    expect(await view(w)).toMatchObject([
      { effectiveDate: '2026-10-18', entryStatus: POSTPONED, contractStartDate: '2026-10-18', contractEndDate: null },
    ]);
    expect(await formalContracts(w)).toEqual([]);
  });

  it('没有待入职合同的存量记录（DEC-402 不回填）：改期照常成功，contractNotice 为 null', async () => {
    const w = await entryWorld(testDb().db, 'f194-legacy');
    const { recordId } = await addPending(w, '2026-10-18');
    expect(await pendingContractRows(w)).toHaveLength(1);
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM employment_pending_entry_contract WHERE tenant_id=${w.session.tenant.id}`),
    );
    const body = await postpone(w, recordId, '2026-10-19');
    expect(body.contractNotice).toBeNull();
    expect(await view(w)).toMatchObject([{ effectiveDate: '2026-10-19', contractStartDate: null }]);
    expect(await pendingContractRows(w)).toEqual([]);
  });
});

describe('F-194 行内编辑不联动合同', () => {
  async function edit(w: EntryWorld, recordId: string, body: object) {
    const response = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('只改计划入职日期 17→20：合同仍从 17 起，响应没有 contractNotice，状态仍为正常', async () => {
    const w = await entryWorld(testDb().db, 'f194-edit');
    const { recordId } = await addPending(w, '2026-10-17');
    const body = await edit(w, recordId, { effectiveDate: '2026-10-20', probation: true });
    expect(body).not.toHaveProperty('contractNotice');
    expect(await view(w)).toMatchObject([
      { effectiveDate: '2026-10-20', entryStatus: NORMAL, contractStartDate: '2026-10-17', contractEndDate: null },
    ]);
    const rows = await pendingContractRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startDate: '2026-10-17', endDate: null });
    expect(await formalContracts(w)).toEqual([]);
  });

  it('日期没改只改试用期：合同原样，响应没有 contractNotice', async () => {
    const w = await entryWorld(testDb().db, 'f194-edit-same');
    const { recordId } = await addPending(w, '2026-10-17');
    const body = await edit(w, recordId, { effectiveDate: '2026-10-17', probation: false });
    expect(body).not.toHaveProperty('contractNotice');
    expect(await view(w)).toMatchObject([{ contractStartDate: '2026-10-17', contractEndDate: null }]);
  });

  it('改期后再编辑：编辑不动改期联动出来的合同日期', async () => {
    const w = await entryWorld(testDb().db, 'f194-edit-after-postpone');
    const { recordId } = await addPending(w, '2026-10-17');
    const postponed = await postpone(w, recordId, '2026-10-18');
    const id = (postponed as { id: string }).id;
    await edit(w, id, { effectiveDate: '2026-10-25', probation: true });
    expect(await view(w)).toMatchObject([
      { effectiveDate: '2026-10-25', entryStatus: POSTPONED, contractStartDate: '2026-10-18' },
    ]);
  });
});

describe('F-194 办理入职沿用合同、不重复生成', () => {
  it('带合同信息：正式合同正好 1 份，字段规则不变（生效日缺省取入职日）；待入职合同不再留存', async () => {
    const { w, contract } = await contractWorld('f194-complete');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    expect((await pendingContractRows(w)).map((row) => row.businessId)).toEqual([recordId]);
    const response = await entryAction(w, recordId, 'complete', { probation: true, contract });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await formalContracts(w)).toMatchObject([
      { employeeId: employee.id, effectiveDate: '2026-09-01', endDate: '2027-10-31', termType: 'fixed' },
    ]);
    expect(await pendingContractRows(w)).toEqual([]);
    expect(await view(w, 'hired')).toMatchObject([{ contractStartDate: null, contractEndDate: null }]);
  });

  it('不带合同信息：不生成正式合同；待入职合同同样不再留存', async () => {
    const { w } = await contractWorld('f194-complete-none');
    const { recordId } = await addPending(w, '2026-09-01');
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    expect(await formalContracts(w)).toEqual([]);
    expect(await pendingContractRows(w)).toEqual([]);
  });

  it('编辑把日期改开后办理入职（03 默认口径）：正式合同生效日仍缺省取入职日，也可显式指定', async () => {
    const { w, contract } = await contractWorld('f194-complete-edited');
    const { recordId } = await addPending(w, '2026-10-17');
    const edit = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { effectiveDate: '2026-10-20', probation: true },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const [item] = await view(w);
    const done = await entryAction(w, item!.id, 'complete', { probation: true, contract });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await formalContracts(w)).toMatchObject([{ effectiveDate: '2026-10-20' }]);
    expect(await pendingContractRows(w)).toEqual([]);
  });
});

describe('F-194 删除待入职清理合同', () => {
  it('删除待入职：合同一并清理；取消入职不清理（供恢复时改期联动）', async () => {
    const w = await entryWorld(testDb().db, 'f194-delete');
    const { recordId } = await addPending(w, '2026-10-17', '待删除员工');
    const kept = await addPending(w, '2026-10-18', '已取消员工');
    await cancel(w, kept.recordId);
    expect(await pendingContractRows(w)).toHaveLength(2);
    const deleted = await w.session.request('DELETE', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await pendingContractRows(w)).toMatchObject([{ businessId: kept.recordId, startDate: '2026-10-18' }]);
  });
});

describe('F-194 失败整笔回滚', () => {
  it('改期过程中合同写入失败：记录、合同、审计都不变', async () => {
    const w = await entryWorld(testDb().db, 'f194-rollback');
    const { recordId } = await addPending(w, '2026-10-18');
    expect(await pendingContractRows(w)).toHaveLength(1);
    await w.db.execute(sql`CREATE FUNCTION f194_test_fail_contract() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.start_date = DATE '2026-10-19' THEN RAISE EXCEPTION 'synthetic pending contract failure'; END IF;
        RETURN NEW;
      END $$`);
    await w.db.execute(sql`CREATE TRIGGER f194_test_fail_contract_trigger
      BEFORE INSERT OR UPDATE ON employment_pending_entry_contract
      FOR EACH ROW EXECUTE FUNCTION f194_test_fail_contract()`);
    try {
      const failed = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-19' });
      expect(failed.status).toBe(500);
      expect(await view(w)).toMatchObject([
        { id: recordId, effectiveDate: '2026-10-18', entryStatus: NORMAL, contractStartDate: '2026-10-18' },
      ]);
      expect(await pendingContractRows(w)).toMatchObject([{ businessId: recordId, startDate: '2026-10-18' }]);
      expect(await auditRows(w, 'employment.entry.postpone')).toEqual([]);
    } finally {
      await w.db.execute(sql`DROP TRIGGER f194_test_fail_contract_trigger ON employment_pending_entry_contract`);
      await w.db.execute(sql`DROP FUNCTION f194_test_fail_contract()`);
    }
    // 故障排除后同一改期可以重提成功
    await postpone(w, recordId, '2026-10-19');
    expect(await view(w)).toMatchObject([{ effectiveDate: '2026-10-19', contractStartDate: '2026-10-19' }]);
  });
});

describe('F-194 租户隔离', () => {
  it('待入职合同表按租户隔离：A 租户的会话看不到 B 租户的合同行', async () => {
    const a = await entryWorld(testDb().db, 'f194-rls-a');
    const b = await entryWorld(testDb().db, 'f194-rls-b');
    const pendingA = await addPending(a, '2026-10-10', 'A 租户员工');
    const employeeB = await b.session.employee('B 租户员工');
    const addedB = await addHire(b.session, employeeB, hireBody(b.org.id, '2026-10-11', { pendingEntry: true }));
    expect(addedB.status).toBe(201);
    expect(await pendingContractRows(a)).toHaveLength(1);
    const seenByA = await withTenant(a.db, a.session.tenant.id, async (tx) => {
      const all = rowsOf<{ tenantId: string; businessId: string }>(
        await tx.execute(sql`SELECT tenant_id AS "tenantId", business_id AS "businessId"
          FROM employment_pending_entry_contract`),
      );
      return all;
    });
    expect(seenByA).toEqual([{ tenantId: a.session.tenant.id, businessId: pendingA.recordId }]);
    expect(await pendingContractRows(b)).toHaveLength(1);
  });
});

describe('F-194 真实授权提供器下列表带合同起止日', () => {
  it('只有任职记录查看权（没有合同对象权限）：contractStartDate / contractEndDate 仍读回（控制项显式投影）', async () => {
    const seed = await seedPermissionWorld(testDb().db);
    const setup = tenantApi(seed.db, { clock });
    const create = async (path: string, body: object, ifMatch = 0) => {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, ifMatch, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string; revision: number };
    };
    const org = await create('org/organizations', {
      name: '合同读回部门',
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: seed.tenant.id } },
    });
    const employee = await create('employment/employees', { code: `E${uniqueSuffix()}`, name: '合同读回员工' });
    await create(
      `employment/employees/${employee.id}/businesses`,
      withLoginEmail(employee.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        fields: { employType: 'internal', departmentId: org.id },
        pendingEntry: true,
      }),
      employee.revision,
    );
    const profile = await createProfile(seed, `read-${uniqueSuffix()}`);
    const employment = MODULE_OBJECTS.employmentRecord;
    const permission = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: employment.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      employment.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(seed, [profile.id]);
    const reader = await addMember(seed, 'contract-reader');
    expect((await grant(seed, reader.id, profile.id)).status).toBe(201);
    const all = await setup.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(all.status, await all.clone().text()).toBe(200);
    const real = tenantApi(seed.db, { authorize: undefined, clock });
    const response = await real.request('GET', '/api/tenant/employment/pending-entries?view=all', {
      user: reader.id,
      tenant: seed.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((item) => [item.effectiveDate, item.contractStartDate, item.contractEndDate])).toEqual([
      ['2026-10-10', '2026-10-10', null],
    ]);
  });
});
