/**
 * BE-6a 新增实习生时按证件号的重聘判定（差距表 B38 / A48 判定部分；31 IN-R1：证件号是固定重聘标识；
 * 补证结论 R2f B41“再入职入口”）。保守口径：只按“证件类型 + 证件号码”在租户内精确匹配已离职 / 退休人员；
 * 多人命中明确拒绝、不自动挑选；手机 / 邮箱匹配与复聘次数未验证、本单不做。
 */
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

interface MatchResult {
  readonly matched: boolean;
  readonly candidate?: {
    readonly employeeId: string;
    readonly name?: string;
    readonly code?: string;
    readonly email?: string | null;
    readonly endKind: 'leave' | 'retirement';
    readonly lastWorkDate?: string | null;
    readonly departmentId?: string | null;
    readonly rehire: boolean;
  };
}

const idNumber = () => `SYN${uniqueSuffix()}`;

async function leftPerson(w: InternWorld, name: string, number: string, email?: string) {
  const person = await w.hire(name, 'intern');
  await w.identify(person.employee.id, 'id_card', number, email);
  await w.leave(person.employee.id, '2026-09-20');
  return person;
}

async function matchOk(w: InternWorld, body: Record<string, unknown>): Promise<MatchResult> {
  const response = await w.match(body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MatchResult;
}

describe('AC-IN-BE6a-06 按证件号的重聘判定', () => {
  it('命中已离职人员：带出姓名、个人邮箱、旧工号、结束类型离职、最后工作日、所在部门，重聘默认否', async () => {
    const w = await internWorld(testDb().db, 'be6a-rehire-hit');
    const number = idNumber();
    const person = await leftPerson(w, '离职合成员工', number, 'left.person@example.com');
    const result = await matchOk(w, { idType: 'id_card', idNumber: ` ${number} ` });
    expect(result).toEqual({
      matched: true,
      candidate: {
        employeeId: person.employee.id,
        name: '离职合成员工',
        code: person.employee.code,
        email: 'left.person@example.com',
        endKind: 'leave',
        lastWorkDate: '2026-09-20',
        departmentId: w.org.id,
        rehire: false,
      },
    });
  });

  it('命中退休人员：结束类型为退休', async () => {
    const w = await internWorld(testDb().db, 'be6a-rehire-retired');
    const number = idNumber();
    const person = await w.hire('退休合成员工', 'internal');
    await w.identify(person.employee.id, 'id_card', number);
    await w.retire(person.employee.id, '2026-09-25');
    const result = await matchOk(w, { idType: 'id_card', idNumber: number });
    expect(result.candidate).toMatchObject({ employeeId: person.employee.id, endKind: 'retirement' });
  });

  it('不命中：证件类型不同、在职人员、未来才离职的人员、其他租户的同号人员', async () => {
    const w = await internWorld(testDb().db, 'be6a-rehire-miss');
    const number = idNumber();
    const active = await w.hire('在职合成员工', 'intern');
    await w.identify(active.employee.id, 'id_card', number);
    const future = await w.hire('未来离职合成员工', 'intern');
    await w.identify(future.employee.id, 'id_card', number);
    await w.leave(future.employee.id, '2026-10-20');
    const otherTenant = await internWorld(testDb().db, 'be6a-rehire-other');
    await leftPerson(otherTenant, '他租户合成员工', number);
    expect(await matchOk(w, { idType: 'id_card', idNumber: number })).toEqual({ matched: false });
    expect(await matchOk(w, { idType: 'passport', idNumber: number })).toEqual({ matched: false });
  });

  it('多人命中 → 409 REHIRE_MATCH_AMBIGUOUS，不自动挑选、不带出任何人员信息', async () => {
    const w = await internWorld(testDb().db, 'be6a-rehire-ambiguous');
    const number = idNumber();
    await leftPerson(w, '同号合成员工一', number);
    await leftPerson(w, '同号合成员工二', number);
    const response = await w.match({ idType: 'id_card', idNumber: number });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details).toEqual({ reason: 'REHIRE_MATCH_AMBIGUOUS' });
  });

  it.each([
    ['缺证件类型', { idNumber: 'SYN1' }],
    ['缺证件号码', { idType: 'id_card' }],
    ['空证件号码', { idType: 'id_card', idNumber: '   ' }],
    ['手机号匹配未验证不受理', { idType: 'id_card', idNumber: 'SYN1', mobilePhone: '13800000000' }],
    ['邮箱匹配未验证不受理', { idType: 'id_card', idNumber: 'SYN1', email: 'a@example.com' }],
  ])('%s → 400', async (_label, body) => {
    const w = await internWorld(testDb().db, `be6a-rehire-invalid-${uniqueSuffix()}`);
    expect((await w.match(body)).status).toBe(400);
  });

  it('非“看全部”范围（新建员工须看全部，DEC-121）→ 404，不判定、不带出', async () => {
    const w = await internWorld(testDb().db, 'be6a-rehire-scope');
    const number = idNumber();
    await leftPerson(w, '范围外合成员工', number);
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        orgIds: [w.org.id],
        hasDataPermission: true,
        terms: [{ dimension: 'organization' as const, orgIds: [w.org.id], personIds: [] }],
      }),
      authorize: async () => true,
      fields: async () => new Set(['code', 'name']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const response = await api.request('POST', '/api/tenant/employment/rehire-matches', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      body: { idType: 'id_card', idNumber: number },
    });
    expect(response.status).toBe(404);
  });
});
