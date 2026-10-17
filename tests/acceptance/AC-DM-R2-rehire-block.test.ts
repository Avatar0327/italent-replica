/**
 * AC-DM-R2（再入职拦截，DEC-569）：黑名单人员不允许再入职。选人不拦，保存时拦：重聘 / 退休返聘 / 离职或退休再入职添加待入职、
 * 以及 hire 匹配到黑名单人员（docs/02_业务建模/34 OF-R2：姓名 + 证件号 / 手机 / 邮箱）一律在保存阶段校验；
 * 提示原文“此人员已被列入黑名单（姓名：…，原因：…），无法执行此操作”，不生成待入职记录（前后读取比对无任何业务写入）。
 * 原站先弹编制预警、确认后才报黑名单：严格控编的超编拒绝先于黑名单。拦截不受自动加黑开关影响。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTABLISHMENT_CHECKS,
  registerEmploymentActivationChecks,
} from '../../apps/api/src/modules/employment/activation-checks.js';
import { addHire, hireBody } from './AC-EN-BE2a-support.js';
import { blacklistWorld, businessCounts, leftEmployee, setPersonIdentity } from './AC-DM-R2-blacklist-support.js';

const testDb = useTestDb();
const MESSAGE = '此人员已被列入黑名单（姓名：拦截员工，原因：稳定性差），无法执行此操作';
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

afterEach(() => registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS));

describe('AC-DM-R2 再入职保存时拦截', () => {
  it.each([
    ['rehire', 'leave', false],
    ['retire_rehire', 'retirement', false],
    ['rehire', 'leave', true],
    ['retire_rehire', 'retirement', true],
  ] as const)('%s（前一段 %s，添加待入职 %s）：409 原文提示，业务表前后不变', async (kind, ending, pending) => {
    const w = await blacklistWorld(testDb().db, `block-${kind}-${pending}`);
    const { employee, org } = await leftEmployee(w.db, w.session, '拦截员工', {}, ending);
    await w.added({ employeeId: employee.id, reason: 'instability' });
    const before = await businessCounts(w.db, w.session.tenant.id);
    const body = { ...hireBody(org.id, '2026-10-10', pending ? { pendingEntry: true } : {}), kind };
    const response = await addHire(w.session, employee, body);
    expect(response.status, await response.clone().text()).toBe(409);
    const body409 = await error(response);
    expect(body409).toMatchObject({ code: 'CONFLICT', message: MESSAGE, details: { reason: 'EMPLOYEE_BLACKLISTED' } });
    expect(await businessCounts(w.db, w.session.tenant.id)).toEqual(before);
  });

  it('hire：新建人员档案与黑名单姓名 + 证件号相同即拦截；只同名不拦', async () => {
    const w = await blacklistWorld(testDb().db, 'block-hire');
    const org = await w.session.org('入职部门-hire', { establishedOn: '2026-01-01' });
    await w.added({ name: '拦截员工', idNumber: 'ID-SYN-0101', reason: 'instability' });
    const same = await w.session.employee('拦截员工');
    await setPersonIdentity(w.db, w.session, same.id, { idNumber: 'id-syn-0101' });
    const before = await businessCounts(w.db, w.session.tenant.id);
    const blocked = await addHire(w.session, same, hireBody(org.id, '2026-10-10', { pendingEntry: true }));
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect((await error(blocked)).message).toBe(MESSAGE);
    expect(await businessCounts(w.db, w.session.tenant.id)).toEqual(before);
    const namesake = await w.session.employee('拦截员工');
    await setPersonIdentity(w.db, w.session, namesake.id, { idNumber: 'ID-SYN-0102' });
    const allowed = await addHire(w.session, namesake, hireBody(org.id, '2026-10-10'));
    expect(allowed.status, await allowed.clone().text()).toBe(201);
  });

  it('已移出、已过有效截止日期的不拦；截止日当天仍拦；删除后不拦', async () => {
    const w = await blacklistWorld(testDb().db, 'not-effective');
    const { employee, org } = await leftEmployee(w.db, w.session, '拦截员工');
    const entry = await w.added({ employeeId: employee.id, reason: 'instability', expiryDate: '2026-10-01' });
    const rehire = { ...hireBody(org.id, '2026-10-10', { pendingEntry: true }), kind: 'rehire' };
    expect((await addHire(w.session, employee, rehire)).status).toBe(409);
    w.session.setNow('2026-10-02T01:00:00.000Z');
    const afterExpiry = await addHire(w.session, employee, rehire);
    expect(afterExpiry.status, await afterExpiry.clone().text()).toBe(201);
    expect((await w.remove([{ id: entry.id, revision: 1 }])).status).toBe(200);
  });

  it('严格控编超编先于黑名单（先编制、后黑名单，DEC-569）', async () => {
    const w = await blacklistWorld(testDb().db, 'establishment-first');
    const { employee, org } = await leftEmployee(w.db, w.session, '拦截员工');
    await w.added({ employeeId: employee.id, reason: 'instability' });
    registerEmploymentActivationChecks({ establishmentExceeded: async () => true });
    const rehire = { ...hireBody(org.id, '2026-10-10', { pendingEntry: true }), kind: 'rehire' };
    const exceeded = await addHire(w.session, employee, rehire);
    expect(exceeded.status).toBe(409);
    expect((await error(exceeded)).details).toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED' });
    registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS);
    expect((await error(await addHire(w.session, employee, rehire))).details).toMatchObject({
      reason: 'EMPLOYEE_BLACKLISTED',
    });
  });

  it('自动加黑总开关关闭（系统值）也拦截；未加黑的离职人员照常重聘', async () => {
    const w = await blacklistWorld(testDb().db, 'switch-off');
    const { employee, org } = await leftEmployee(w.db, w.session, '拦截员工');
    await w.added({ employeeId: employee.id, reason: 'instability' });
    const rehire = { ...hireBody(org.id, '2026-10-10'), kind: 'rehire' };
    expect((await addHire(w.session, employee, rehire)).status).toBe(409);
    const clean = await leftEmployee(w.db, w.session, '未加黑员工');
    expect((await addHire(w.session, clean.employee, rehire)).status).toBe(201);
  });
});
