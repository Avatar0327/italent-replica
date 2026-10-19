/**
 * R2 BE-5c1a（R2-T04 §2.3 末段，DEC-638 A-20；AC-RT-21 手工部分、AC-RT-23③ 手工部分）：
 * 人事新增六列（预计退休日期已核准、个人身份、最早 / 最晚退休日期、弹性范围已核准、原预计退休日期）；
 * normalizeRetirementRange 在 appendEmployee 一处生效（人事 PATCH、子集反写、批处理等所有入口同一函数）：
 * - 预计退休日期 P 为空时上下限一律清空（清空优先于“弹性范围已核准”，核准标志本身保留）；
 * - P 为空而请求显式给了非空上下限 → 400 RETIREMENT_RANGE_WITHOUT_EXPECTED_DATE；
 * - 上下限都非空时只校验次序 earliest ≤ latest（400 RETIREMENT_RANGE_INVALID），不要求 P 落在范围内。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { personnelSession } from './AC-SUB-support.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

const RANGE = { earliestRetirementDate: '2029-06-01', latestRetirementDate: '2031-06-01' };
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;

async function seeded(label: string, flexibleConfirmed: boolean) {
  const s = await personnelSession(testDb().db, `rt-range-${label}`);
  const path = `/employees/${s.employee.id}`;
  const patch = (revision: number, body: Record<string, unknown>) =>
    s.request('PATCH', path, { ifMatch: revision, body });
  const created = await patch(0, {
    expectedRetirementDate: '2030-06-01',
    expectedRetirementConfirmed: false,
    ...RANGE,
    flexibleRangeConfirmed: flexibleConfirmed,
  });
  expect(created.status, await created.clone().text()).toBe(200);
  return { ...s, path, patch };
}

/** 内部入口（批处理、子集反写同形）：直接调 appendEmployee，不过人事 PATCH 路由。 */
async function internalAppend(s: Awaited<ReturnType<typeof seeded>>, patch: Record<string, unknown>) {
  return withTenant(testDb().db, s.tenant.id, (tx) =>
    appendEmployee(
      tx,
      {
        tenantId: s.tenant.id,
        userId: s.user.id,
        timezone: 'Asia/Shanghai',
        expectedRevision: 0,
        commandId: `rt-range-${randomUUID()}`,
        now: new Date('2026-10-01T01:00:00Z'),
      },
      s.employee.id,
      patch,
      false,
    ),
  );
}

async function current(s: Awaited<ReturnType<typeof seeded>>) {
  const response = await s.request('GET', s.path);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('AC-RT-21 新增人事字段', () => {
  it('六个字段默认空；预计退休日期已核准等布尔字段可写；原预计退休日期是系统字段，不接受手写', async () => {
    const s = await personnelSession(testDb().db, 'rt-range-fields');
    const path = `/employees/${s.employee.id}`;
    const before = (await (await s.request('GET', path)).json()) as Record<string, unknown>;
    for (const key of [
      'expectedRetirementConfirmed',
      'identityType',
      'earliestRetirementDate',
      'latestRetirementDate',
      'flexibleRangeConfirmed',
      'originalExpectedRetirementDate',
    ])
      expect(before, key).toHaveProperty(key, null);
    const system = await s.request('PATCH', path, { ifMatch: 0, body: { originalExpectedRetirementDate: '2030-01-01' } });
    expect(system.status).toBe(400);
    const ok = await s.request('PATCH', path, {
      ifMatch: 0,
      body: { expectedRetirementDate: '2030-06-01', expectedRetirementConfirmed: true, flexibleRangeConfirmed: true },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({
      expectedRetirementDate: '2030-06-01',
      expectedRetirementConfirmed: true,
      flexibleRangeConfirmed: true,
      earliestRetirementDate: null,
      latestRetirementDate: null,
    });
  });
});

describe('AC-RT-21 P 为空 × 弹性范围已核准（A-20，手工部分）', () => {
  it.each([true, false])('弹性范围已核准 = %s：HR 手工清空 P → 同一版本里上下限清空，核准标志不变', async (confirmed) => {
    const s = await seeded(`clear-${confirmed}`, confirmed);
    const cleared = await s.patch(1, { expectedRetirementDate: null });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({
      expectedRetirementDate: null,
      earliestRetirementDate: null,
      latestRetirementDate: null,
      flexibleRangeConfirmed: confirmed,
      revision: 2,
    });
    const history = rows<{ revision: number }>(
      await withTenant(testDb().db, s.tenant.id, (tx) =>
        tx.execute(sql`SELECT revision FROM personnel_employee_versions WHERE tenant_id = ${s.tenant.id}
          AND employee_id = ${s.employee.id}::uuid ORDER BY revision`),
      ),
    );
    expect(history.map((row) => row.revision)).toEqual([1, 2]);
  });

  it.each([true, false])('弹性范围已核准 = %s：内部入口（appendEmployee，批处理同形）清空 P 同样清空上下限', async (confirmed) => {
    const s = await seeded(`internal-${confirmed}`, confirmed);
    await internalAppend(s, { expectedRetirementDate: null });
    expect(await current(s)).toMatchObject({
      expectedRetirementDate: null,
      earliestRetirementDate: null,
      latestRetirementDate: null,
      flexibleRangeConfirmed: confirmed,
      revision: 2,
    });
  });

  it('P 为空时手工提交非空上下限 400 RETIREMENT_RANGE_WITHOUT_EXPECTED_DATE，不产生新版本', async () => {
    const s = await personnelSession(testDb().db, 'rt-range-empty-p');
    const path = `/employees/${s.employee.id}`;
    for (const body of [
      RANGE,
      { earliestRetirementDate: '2029-06-01' },
      { latestRetirementDate: '2031-06-01' },
      { expectedRetirementDate: null, ...RANGE },
    ]) {
      const response = await s.request('PATCH', path, { ifMatch: 0, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(response)).details?.reason).toBe('RETIREMENT_RANGE_WITHOUT_EXPECTED_DATE');
    }
    expect(await (await s.request('GET', path)).json()).toMatchObject({ revision: 0, earliestRetirementDate: null });
    // 显式给 null 不算“提交非空上下限”
    const nulls = await s.request('PATCH', path, {
      ifMatch: 0,
      body: { earliestRetirementDate: null, latestRetirementDate: null, flexibleRangeConfirmed: true },
    });
    expect(nulls.status, await nulls.clone().text()).toBe(200);
  });

  it('内部入口显式给非空上下限而 P 为空同样拒绝（同一函数）', async () => {
    const s = await personnelSession(testDb().db, 'rt-range-internal-reject');
    await expect(
      withTenant(testDb().db, s.tenant.id, (tx) =>
        appendEmployee(
          tx,
          {
            tenantId: s.tenant.id,
            userId: s.user.id,
            timezone: 'Asia/Shanghai',
            expectedRevision: 0,
            commandId: `rt-range-${randomUUID()}`,
            now: new Date('2026-10-01T01:00:00Z'),
          },
          s.employee.id,
          { earliestRetirementDate: '2029-06-01' },
          false,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'RETIREMENT_RANGE_WITHOUT_EXPECTED_DATE' } });
  });
});

describe('AC-RT-21 / 23 上下限次序，P 不必落在范围内', () => {
  it('上下限都非空时 earliest ≤ latest；相等可以；只给一端不校验次序', async () => {
    const s = await personnelSession(testDb().db, 'rt-range-order');
    const path = `/employees/${s.employee.id}`;
    const first = await s.request('PATCH', path, { ifMatch: 0, body: { expectedRetirementDate: '2030-06-01' } });
    expect(first.status).toBe(200);
    const inverted = await s.request('PATCH', path, {
      ifMatch: 1,
      body: { earliestRetirementDate: '2031-06-01', latestRetirementDate: '2029-06-01' },
    });
    expect(inverted.status).toBe(400);
    expect((await errorOf(inverted)).details?.reason).toBe('RETIREMENT_RANGE_INVALID');
    const equal = await s.request('PATCH', path, {
      ifMatch: 1,
      body: { earliestRetirementDate: '2030-06-01', latestRetirementDate: '2030-06-01' },
    });
    expect(equal.status, await equal.clone().text()).toBe(200);
    const one = await s.request('PATCH', path, { ifMatch: 2, body: { latestRetirementDate: '2028-01-01' } });
    expect(one.status).toBe(400);
    const lone = await s.request('PATCH', path, { ifMatch: 2, body: { earliestRetirementDate: null } });
    expect(lone.status, await lone.clone().text()).toBe(200);
  });

  it('AC-RT-23③ 手工：HR 把未核准的 P 改到旧范围之外，保存成功、上下限不变、只多一个版本', async () => {
    const s = await seeded('p-outside', true);
    const moved = await s.patch(1, { expectedRetirementDate: '2035-06-01' });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await moved.json()).toMatchObject({
      expectedRetirementDate: '2035-06-01',
      ...RANGE,
      flexibleRangeConfirmed: true,
      revision: 2,
    });
  });

  it('P 与范围无关的写入（改手机）不动上下限', async () => {
    const s = await seeded('unrelated', false);
    const changed = await s.patch(1, { mobilePhone: 'SYNTHETIC-RT' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ...RANGE, expectedRetirementDate: '2030-06-01', revision: 2 });
  });
});
