/**
 * BE-6a 实习四视图（差距表 B34～B37；31 §补充“人员信息各列表的过滤口径”、Q-M0-122 ④）：
 * 实习中 = 雇佣关系实习生 + 人员状态正式 + 主职当前生效；实习转正中 = 实习转正审批中 / 审批通过未生效；
 * 已转正 = 生效的实习转正记录（直接或申请）；已离职 = 实习生身份的离职记录（结束实习归 BE-6b，本单只读已有离职）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { internWorld, names, type InternViewItem, type InternWorld } from './AC-IN-BE6a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

/** 一个租户里的七种人：在职实习生 / 转正中 / 直接转正 / 申请转正 / 已离职实习生 / 内部员工 / 待入职实习生。 */
async function seed(w: InternWorld) {
  const interning = await w.hire('实习中合成实习生', 'intern');
  const converting = await w.hire('转正中合成实习生', 'intern');
  const direct = await w.hire('直接转正合成实习生', 'intern');
  const left = await w.hire('已离职合成实习生', 'intern');
  const staff = await w.hire('内部合成员工', 'internal');
  const pending = await w.hire('待入职合成实习生', 'intern', { effectiveDate: '2026-10-10', pendingEntry: true });
  const convertingId = await w.applyRegularization(converting.employee.id);
  const regularized = await w.regularize(direct.employee.id, {
    effectiveDate: '2026-09-20',
    departmentId: w.other.id,
    probation: true,
    probationMonths: 2,
  });
  expect(regularized.status, await regularized.clone().text()).toBe(201);
  const directId = ((await regularized.json()) as { id: string }).id;
  const leave = await w.leave(left.employee.id, '2026-09-20');
  return { interning, converting, convertingId, direct, directId, left, leaveId: leave.id, staff, pending };
}

describe('AC-IN-BE6a-04 实习四视图', () => {
  it('四个视图按雇佣关系、人员状态与实习转正状态分流；内部员工与待入职实习生不出现', async () => {
    const w = await internWorld(testDb().db, 'be6a-views');
    await seed(w);
    expect(names(await w.view('interning'))).toEqual(['实习中合成实习生', '转正中合成实习生'].sort());
    expect(names(await w.view('converting'))).toEqual(['转正中合成实习生']);
    expect(names(await w.view('converted'))).toEqual(['直接转正合成实习生']);
    expect(names(await w.view('left'))).toEqual(['已离职合成实习生']);
  });

  it('条目形状：实习中带实习入职日；转正中带审批状态；已转正带试用期；已离职带最后工作日', async () => {
    const w = await internWorld(testDb().db, 'be6a-views-shape');
    const s = await seed(w);
    const [interning] = await w.view('interning', `&keyword=${encodeURIComponent('实习中')}`);
    expect(interning).toMatchObject({
      id: s.interning.hireId,
      employeeId: s.interning.employee.id,
      code: s.interning.employee.code,
      kind: 'hire',
      entryDate: '2026-09-01',
      departmentId: w.org.id,
      employType: 'intern',
      employeeStatus: 3,
      state: 'effective',
    });
    expect(interning!.revision).toBeGreaterThan(0);
    const [converting] = await w.view('converting');
    expect(converting).toMatchObject({
      id: s.convertingId,
      kind: 'intern_regularization',
      effectiveDate: '2026-10-20',
      state: 'in_review',
      probation: null,
    });
    const [converted] = await w.view('converted');
    expect(converted).toMatchObject({
      id: s.directId,
      kind: 'intern_regularization',
      effectiveDate: '2026-09-20',
      employType: 'internal',
      departmentId: w.other.id,
      employeeStatus: 2,
      probation: { startDate: '2026-09-20', months: 2, endDate: '2026-11-19' },
    });
    const [left] = await w.view('left');
    expect(left).toMatchObject({ id: s.leaveId, kind: 'leave', lastWorkDate: '2026-09-20', employType: 'intern' });
  });

  it('申请审批通过后到期生效：从“实习转正中”移到“已转正”', async () => {
    const w = await internWorld(testDb().db, 'be6a-views-approved');
    const intern = await w.hire('申请转正合成实习生', 'intern');
    const id = await w.applyRegularization(intern.employee.id, '2026-10-01');
    const service = await import('../../apps/api/src/modules/employment/transitions.js');
    const current = (await (await w.session.request('GET', `/businesses/${id}`)).json()) as { revision: number };
    await service.runEmploymentTransition(
      w.db,
      {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id, action: 'approve' },
    );
    expect(names(await w.view('converting'))).toEqual([]);
    expect(names(await w.view('converted'))).toEqual(['申请转正合成实习生']);
    expect(names(await w.view('interning'))).toEqual([]);
  });

  it('筛选：部门、关键字（姓名 / 工号）；分页 pageSize / page 生效，超上限 400', async () => {
    const w = await internWorld(testDb().db, 'be6a-views-filter');
    const first = await w.hire('甲合成实习生', 'intern');
    await w.hire('乙合成实习生', 'intern');
    const elsewhere = await w.hire('丙合成实习生', 'intern');
    expect(
      (
        await w.regularize(elsewhere.employee.id, {
          effectiveDate: '2026-10-16',
          departmentId: w.other.id,
          probation: false,
        })
      ).status,
    ).toBe(201);
    expect(names(await w.view('interning', `&departmentId=${w.org.id}`))).toEqual(['乙合成实习生', '甲合成实习生']);
    expect(names(await w.view('converted', `&departmentId=${w.org.id}`))).toEqual([]);
    expect(names(await w.view('interning', `&keyword=${first.employee.code}`))).toEqual(['甲合成实习生']);
    const page1 = await w.view('interning', '&pageSize=1&page=1');
    const page2 = await w.view('interning', '&pageSize=1&page=2');
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0]!.id).not.toBe(page2[0]!.id);
    expect((await w.session.request('GET', '/interns?view=interning&pageSize=1000')).status).toBe(400);
  });

  it.each(['', 'view=all', 'view=interning&departmentId=bad', 'view=interning&keyword=' + 'x'.repeat(101)])(
    '非法查询 %s → 400',
    async (query) => {
      const w = await internWorld(testDb().db, `be6a-views-bad-${randomUUID()}`);
      expect((await w.session.request('GET', `/interns?${query}`)).status).toBe(400);
    },
  );

  it('已离职视图只认实习生身份的离职：内部员工离职不出现', async () => {
    const w = await internWorld(testDb().db, 'be6a-views-left');
    const staff = await w.hire('离职内部合成员工', 'internal');
    await w.leave(staff.employee.id);
    expect(await w.view('left')).toEqual([]);
  });
});

describe('AC-IN-BE6a-05 实习四视图的数据范围与字段裁剪（fail-closed）', () => {
  async function scoped(w: InternWorld, orgIds: readonly string[], fields: readonly string[]) {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        orgIds,
        hasDataPermission: orgIds.length > 0,
        terms: orgIds.length ? [{ dimension: 'organization' as const, orgIds, personIds: [] }] : [],
      }),
      authorize: async () => true,
      fields: async () => new Set(fields),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
    return async (name: string) => {
      const response = await api.request('GET', `/api/tenant/employment/interns?view=${name}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { items: InternViewItem[]; hasDataPermission: boolean };
    };
  }

  it('只看到范围内部门的实习生；范围为空什么也看不到', async () => {
    const w = await internWorld(testDb().db, 'be6a-scope');
    await w.hire('本部门合成实习生', 'intern');
    const other = await w.hire('他部门合成实习生', 'intern');
    expect(
      (
        await w.regularize(other.employee.id, {
          effectiveDate: '2026-10-16',
          departmentId: w.other.id,
          probation: false,
        })
      ).status,
    ).toBe(201);
    const all = ['id', 'employeeId', 'code', 'name', 'kind', 'effectiveDate', 'departmentId'];
    const inScope = await scoped(w, [w.org.id], all);
    expect(names((await inScope('interning')).items)).toEqual(['本部门合成实习生']);
    expect((await inScope('converted')).items).toEqual([]);
    const empty = await (await scoped(w, [], all))('interning');
    expect(empty.items).toEqual([]);
    expect(empty.hasDataPermission).toBe(false);
  });

  it('不可见字段不出现：任职字段按任职记录可见字段，姓名 / 工号按人员对象可见字段', async () => {
    const w = await internWorld(testDb().db, 'be6a-trim');
    await w.hire('裁剪合成实习生', 'intern');
    const [item] = (await (await scoped(w, [w.org.id], ['id', 'employeeId', 'kind', 'effectiveDate']))('interning'))
      .items;
    expect(item).toMatchObject({ kind: 'hire', effectiveDate: '2026-09-01' });
    expect(item).not.toHaveProperty('departmentId');
    expect(item).not.toHaveProperty('name');
    expect(item).not.toHaveProperty('code');
  });
});
