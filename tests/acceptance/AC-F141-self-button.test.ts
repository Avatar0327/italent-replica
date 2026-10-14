/**
 * F-141 ①（DEC-500）：员工自助按钮要跟员工自动身份打通。
 * 通用对象权限查询 GET /permission/me/objects/:code 此前只叠加手工授权与经理身份，没有叠加员工自动身份，
 * 所以 SelfPage 的“本人调动申请”按钮对只有员工身份的人永远隐藏。
 * 只放开员工身份本来就有的权限，且仅限已绑定员工的本人：未绑定的成员什么都看不到；管理员把按钮从员工身份里关掉后按钮也消失。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_BUTTONS, STANDARD_PROFILES, EMPLOYEE_SELF_SERVICE_CODE } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { approvalWorld } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const RECORD = 'TenantBase.EmploymentRecord';
const EMP_DEF = STANDARD_PROFILES.find((p) => p.code === EMPLOYEE_SELF_SERVICE_CODE)!;

interface MyObject {
  buttons: { buttonCode: string; level: string }[];
  dataOperations: { create: boolean };
  viewableFields: string[];
}

async function scene(label: string) {
  const world = await approvalWorld(testDb().db, label);
  await withTenant(world.db, world.tenant.id, (tx) =>
    installProfile(
      tx,
      { tenantId: world.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
      EMP_DEF,
    ),
  );
  const department = await world.org('合成部门');
  const bound = await world.person('绑定员工', department);
  const unbound = await world.member('未绑定成员');
  // 真实授权器（approvalWorld 的默认请求器是放行的测试授权器）
  const api = tenantApi(world.db, { authorize: undefined, clock: world.clock });
  const mine = (userId: string) => api.request('GET', `/api/tenant/permission/me/objects/${RECORD}`, world.as(userId));
  return { world, bound, unbound, mine };
}

describe('AC-F141-self-button 员工自动身份进入通用对象权限查询（DEC-500①）', () => {
  it('绑定员工只靠员工自动身份，就能看到本人调动三个按钮与出厂字段', async () => {
    const { bound, mine } = await scene('f141-self-button-bound');
    const res = await mine(bound.userId);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as MyObject;
    for (const { buttonCode, level } of EMPLOYEE_SELF_SERVICE_BUTTONS)
      expect(body.buttons, buttonCode).toContainEqual({ buttonCode, level });
    expect(body.dataOperations.create).toBe(true);
    expect(body.viewableFields).toContain('departmentId');
  });

  it('未绑定员工的成员得不到员工身份：对任职对象 403，看不到任何按钮', async () => {
    const { unbound, mine } = await scene('f141-self-button-unbound');
    expect((await mine(unbound)).status).toBe(403);
  });

  it('管理员把按钮从员工身份里关掉后，绑定员工也看不到该按钮', async () => {
    const { world, bound, mine } = await scene('f141-self-button-off');
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`
        DELETE FROM permission_profile_buttons WHERE button_code='Transfer.Self' AND profile_id IN
          (SELECT id FROM permission_profiles WHERE code=${EMPLOYEE_SELF_SERVICE_CODE})`),
    );
    const body = (await (await mine(bound.userId)).json()) as MyObject;
    expect(body.buttons.map((b) => b.buttonCode)).not.toContain('Transfer.Self');
    expect(body.buttons.map((b) => b.buttonCode)).toContain('Employment.Create');
  });

  it('员工自动身份不扩大到他人：绑定员工仍读不到任职列表与人员列表（数据范围不变）', async () => {
    const { world, bound } = await scene('f141-self-button-scope');
    const api = tenantApi(world.db, { authorize: undefined, clock: world.clock });
    for (const path of ['/api/tenant/employment/employees', '/api/tenant/employment/records']) {
      const res = await api.request('GET', path, world.as(bound.userId));
      expect([403, 404], path).toContain(res.status);
    }
  });
});
