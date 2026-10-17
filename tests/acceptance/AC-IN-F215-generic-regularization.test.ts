/**
 * F-215（PR #386 第 2 轮后补）：通用任职新增接口 POST /employees/:id/businesses 提交实习转正，与专用直接转正接口走同一套
 * 资格检查（31 IN-R4：结束实习只能重聘；只有在职实习生可转正），不能绕过。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();

async function generic(w: InternWorld, employeeId: string, body: Record<string, unknown>) {
  const ifMatch = await w.revision(employeeId);
  const response = await w.session.request('POST', `/employees/${employeeId}/businesses`, { ifMatch, body });
  return { response, ifMatch };
}

const kinds = async (w: InternWorld, employeeId: string) =>
  (await w.session.records(employeeId, '2026-12-31')).map((record) => record.kind).sort();

describe('AC-IN-F215 通用新增接口的实习转正资格', () => {
  it.each(['direct', 'application'])(
    '已于 09-20 离职的实习生回填 09-15 转正（%s）→ 409 ACTIVE_EMPLOYMENT_REQUIRED，不产生记录',
    async (mode) => {
      const w = await internWorld(testDb().db, `f215-left-${mode}`);
      const { employee } = await w.hire('已离职合成实习生', 'intern');
      await w.leave(employee.id, '2026-09-20');
      const body = { kind: 'intern_regularization', mode, effectiveDate: '2026-09-15', fields: {} };
      const { response, ifMatch } = await generic(w, employee.id, body);
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
      expect(await kinds(w, employee.id)).toEqual(['hire', 'leave']);
      expect(await w.revision(employee.id)).toBe(ifMatch);
    },
  );

  it('内部员工经通用接口提交实习转正 → 409 NOT_INTERN', async () => {
    const w = await internWorld(testDb().db, 'f215-not-intern');
    const { employee } = await w.hire('内部合成员工', 'internal');
    const body = { kind: 'intern_regularization', mode: 'direct', effectiveDate: '2026-09-15', fields: {} };
    const { response } = await generic(w, employee.id, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'NOT_INTERN' } } });
  });

  it('在职实习生经通用接口直接转正仍可保存（不误伤）', async () => {
    const w = await internWorld(testDb().db, 'f215-ok');
    const { employee } = await w.hire('在职合成实习生', 'intern');
    const body = { kind: 'intern_regularization', mode: 'direct', effectiveDate: '2026-09-15', fields: {} };
    expect((await generic(w, employee.id, body)).response.status).toBe(201);
  });
});
