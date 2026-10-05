/**
 * PR #73 第二轮修改清单（astra 首审）：删除中间任职会恢复前一条的有效区间，恢复的那一段必须满足与新增 / 编辑相同的约束。
 * - P1-1：前一条不在操作人数据范围内时整单拒绝（DEC-178 联动不可见即拒绝，DEC-084 拒绝码；DEC-193）。
 * - P2-1：在途申请的拒绝详情按操作人范围与字段权限裁剪，范围外申请只计数不给明细（DEC-126）。
 * - P2-2：恢复区间不得形成循环汇报（`19` §3.1，AC-EMP-15 同口径）。
 * - P2-3：恢复区间内前一条的部门不得已停用（DEC-129 / DEC-150）。
 * - P2-4：恢复区间按实际区间计算严格编制（DEC-145），不把它误算成整个周期。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { NOW, RECORD_FIELDS, scopedWorld } from './AC-TRF-delete-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('P1-1 删除中间记录：前一条不在操作人范围内时整单拒绝', () => {
  it('只管 B 的操作人删除 9/10 的 B 记录被拒（前一条在 A）；时间轴不变。A、B 都管时可删', async () => {
    const w = await scopedWorld(database().db, 'p1');
    await w.addBusiness({
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-25',
      fields: { departmentId: w.c.id },
    });
    const before = await w.timeline();
    const onlyB = w.operator([w.b.id]);
    const readable = await onlyB.request('GET', `/api/tenant/employment/businesses/${w.toB.id}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
    });
    expect(readable.status).toBe(200);
    const refused = await w.remove(onlyB, w.toB.id);
    expect(refused.status, await refused.clone().text()).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    expect(await w.timeline()).toEqual(before);
    expect(await w.business(w.toB.id)).toMatchObject({ status: 'effective' });

    const both = w.operator([w.a.id, w.b.id]);
    const deleted = await w.remove(both, w.toB.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toEqual([
      { id: w.subject.hire.id, stopDate: '2026-09-24' },
      expect.objectContaining({ stopDate: '9999-12-31' }),
    ]);
  });
});

describe('P2-1 在途申请拒绝详情按范围与字段权限裁剪', () => {
  it('范围外的在途申请只计数、不给单号与日期；仍然拒绝删除。范围内按字段权限裁剪', async () => {
    const w = await scopedWorld(database().db, 'p21');
    // 员工当前已在范围外的 C（DEC-177 ②不成立），其后的申请也在 C：申请对只管 A、B 的操作人不可见。
    await w.addBusiness({
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-25',
      fields: { departmentId: w.c.id },
    });
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.c.id });
    const refused = await w.remove(w.operator([w.a.id, w.b.id]), w.toB.id);
    const text = await refused.text();
    expect(refused.status, text).toBe(409);
    expect(JSON.parse(text)).toMatchObject({
      error: {
        message: '该员工有在途申请，请先撤销或驳回后再删除',
        details: { reason: 'EMPLOYMENT_PENDING_APPLICATION_EXISTS', applications: [], hiddenCount: 1 },
      },
    });
    expect(text).not.toContain(application.id);
    expect(text).not.toContain('2026-10-20');

    const noDate = w.operator(
      [w.a.id, w.b.id, w.c.id],
      RECORD_FIELDS.filter((field) => field !== 'effectiveDate'),
    );
    const trimmed = await w.remove(noDate, w.toB.id);
    expect(trimmed.status).toBe(409);
    const body = (await trimmed.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details).toMatchObject({ hiddenCount: 0 });
    expect(body.error.details.applications).toEqual([{ id: application.id, kind: 'transfer', status: 'in_review' }]);
    expect(await w.business(w.toB.id)).toMatchObject({ status: 'effective' });
  });
});

describe('P2-2～P2-4 恢复区间的业务约束', () => {
  it('P2-2 删除中间记录会让前一条的经理与他人互为经理时拒绝（循环汇报），时间轴不变', async () => {
    const w = await activationWorld(database().db, 'p22-cycle');
    const yi = await w.hired('乙');
    const jiaEmployee = await w.session.employee('甲');
    const jiaHire = await w.session.business(
      jiaEmployee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.from.id, directManagerId: yi.employee.id },
      },
      jiaEmployee.revision,
    );
    const transfer = async (employeeId: string, date: string, fields: Record<string, unknown>) => {
      const employee = await w.session.getEmployee(employeeId);
      return w.session.business(
        employeeId,
        { kind: 'transfer', mode: 'direct', effectiveDate: date, fields },
        employee.revision,
      );
    };
    const middle = await transfer(jiaEmployee.id, '2026-09-10', { departmentId: w.to.id, directManagerId: null });
    await transfer(jiaEmployee.id, '2026-09-25', { departmentId: w.from.id, directManagerId: null });
    await transfer(yi.employee.id, '2026-09-15', { departmentId: w.from.id, directManagerId: jiaEmployee.id });
    const before = await w.session.records(jiaEmployee.id);

    const response = await w.session.request('DELETE', `/businesses/${middle.id}`, {
      ifMatch: (await w.business(middle.id)).revision,
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'REPORTING_CYCLE' } } });
    expect(await w.session.records(jiaEmployee.id)).toEqual(before);
    expect(jiaHire.status).toBe('effective');
  });

  it('P2-3 前一条的部门在恢复区间中途停用时拒绝删除；停用在恢复区间之后则允许', async () => {
    for (const [label, disableOn, expected] of [
      ['p23-inside', '2026-09-15', 400],
      ['p23-after', '2026-09-28', 200],
    ] as const) {
      const w = await activationWorld(database().db, label);
      const third = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
      const person = await w.hired('停用部门员工');
      const transfer = async (date: string, departmentId: string) => {
        const employee = await w.session.getEmployee(person.employee.id);
        return w.session.business(
          person.employee.id,
          { kind: 'transfer', mode: 'direct', effectiveDate: date, fields: { departmentId } },
          employee.revision,
        );
      };
      const middle = await transfer('2026-09-10', w.to.id);
      await transfer('2026-09-25', third.id);
      const api = tenantApi(w.db, { clock: NOW });
      const disabled = await api.request('PATCH', `/api/tenant/org/organizations/${w.from.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: w.from.revision,
        body: { enabled: false, effectiveDate: disableOn },
      });
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      const before = await w.session.records(person.employee.id);
      const response = await w.session.request('DELETE', `/businesses/${middle.id}`, {
        ifMatch: (await w.business(middle.id)).revision,
      });
      expect(response.status, await response.clone().text()).toBe(expected);
      if (expected === 400) {
        expect(await response.json()).toMatchObject({
          error: { details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' } },
        });
        expect(await w.session.records(person.employee.id)).toEqual(before);
      }
    }
  });

  it.each([
    ['恢复区间内有人调入，超出严格编制被拒', '2026-09-15', 409],
    ['他人在恢复区间结束后才调入，不按整个周期误算', '2026-09-25', 200],
  ] as const)('P2-4 %s', async (_label, otherDate, expected) => {
    const w = await activationWorld(database().db, `p24-${otherDate}`);
    const api = tenantApi(w.db, { clock: NOW });
    const establishment = (path: string, body: object) =>
      api.request('POST', `/api/tenant/establishment${path}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body,
      });
    const scheme = await establishment('/schemes', {
      name: '合成严格控编方案',
      periodType: 'annual',
      maintenanceMode: 'local',
      startDate: '2026-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    });
    expect(scheme.status).toBe(201);
    const capacity = await establishment('/capacities', {
      orgId: w.to.id,
      schemeId: ((await scheme.json()) as { id: string }).id,
      periodStart: '2026-01-01',
      localCapacity: 1,
      strictControl: true,
    });
    expect(capacity.status).toBe(201);
    const third = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
    const jia = await w.session.employee('甲');
    await w.session.business(
      jia.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.to.id } },
      jia.revision,
    );
    const transfer = async (employeeId: string, date: string, departmentId: string) => {
      const employee = await w.session.getEmployee(employeeId);
      return w.session.business(
        employeeId,
        { kind: 'transfer', mode: 'direct', effectiveDate: date, fields: { departmentId } },
        employee.revision,
      );
    };
    const out = await transfer(jia.id, '2026-09-10', w.from.id);
    await transfer(jia.id, '2026-09-25', third.id);
    const yi = await w.hired('乙');
    await transfer(yi.employee.id, otherDate, w.to.id);

    const response = await w.session.request('DELETE', `/businesses/${out.id}`, {
      ifMatch: (await w.business(out.id)).revision,
    });
    expect(response.status, await response.clone().text()).toBe(expected);
    if (expected === 409)
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  });
});
