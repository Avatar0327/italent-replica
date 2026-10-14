/**
 * F-141 缺陷 1（DEC-500）第 2 轮：员工自动身份只作用于本人入口（员工身份契约 §2.2），不并进对他人数据生效的功能和字段授权。
 * - 受限用户读同事的任职链，只返回自己身份获准的字段；
 * - 只能改生效日期的用户改同事草稿的部门：403，库里没有落新部门；
 * - 本人调动三个按钮的可见性由本人入口（GET /self-service/profile 的 selfServiceButtons）单独判定，撤按钮即时生效；
 * - 通用对象权限查询（/me/objects）不叠加员工身份：只有员工身份的人对任职对象仍 403。
 * 真实授权器；设了 TEST_DATABASE_URL 时跑在真 PostgreSQL 上。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_BUTTONS, EMPLOYEE_SELF_SERVICE_CODE, STANDARD_PROFILES } from '@italent/domain';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { approvalWorld, grantVisibleFields, permissionAdmin, transferScene } from './AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const RECORD = 'TenantBase.EmploymentRecord';
const EMP_DEF = STANDARD_PROFILES.find((p) => p.code === EMPLOYEE_SELF_SERVICE_CODE)!;
/** DEC-205 员工身份默认可见的他人档案字段：受限用户不该因为自己是员工就多拿到它们。 */
const EMPLOYEE_ONLY_FIELDS = ['departmentId', 'postId', 'levelId', 'directManagerId', 'sequenceId'];

async function scene(label: string) {
  const w = await approvalWorld(testDb().db, label);
  await withTenant(w.db, w.tenant.id, (tx) =>
    installProfile(tx, { tenantId: w.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() }, EMP_DEF),
  );
  const s = await transferScene(w);
  const world = await permissionAdmin(w);
  // 经理自动身份会另给默认字段（DEC-205）：配一个空的同编码身份，避免干扰“只获准字段”的断言
  await createProfile(world, 'department_manager_self_service');
  const restricted = await w.person('受限员工', s.from);
  const scopeAll = await world.api.request('PUT', `/api/tenant/permission/scopes/${restricted.userId}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      kind: 'org_range',
      orgRanges: [s.from, s.to].map((orgId) => ({ orgId, includeDescendants: true })),
    },
  });
  expect(scopeAll.status, await scopeAll.clone().text()).toBe(200);
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  return { w, s, world, restricted, api };
}

describe('AC-F141-self-button 员工自动身份只作用于本人入口（DEC-500，P1 返工）', () => {
  it('受限用户读同事任职链：只返回自己身份获准的字段，不因是员工多出默认字段', async () => {
    const { w, s, world, restricted, api } = await scene('f141-self-read');
    await grantVisibleFields(world, restricted.userId, ['id', 'effectiveDate']);
    const res = await api.request('GET', `/api/tenant/employment/employees/${s.subject.employeeId}/records`, {
      ...w.as(restricted.userId),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { items: { fields?: Record<string, unknown> }[] } & Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('effectiveDate');
    const text = JSON.stringify(body);
    for (const field of EMPLOYEE_ONLY_FIELDS) expect(text, field).not.toContain(`"${field}"`);
  });

  it('只能改生效日期的用户改同事草稿的部门：403，库里仍是原部门', async () => {
    const { w, s, world, restricted, api } = await scene('f141-self-write');
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const profile = await createProfile(world, `edit${randomUUID().replaceAll('-', '')}`);
    const set = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: MODULE_OBJECTS.employmentRecord.fields.map((f) => ({
          fieldCode: f.code,
          view: ['id', 'effectiveDate'].includes(f.code),
          edit: f.code === 'effectiveDate',
        })),
        buttons: [{ buttonCode: 'Employment.Edit', level: 'detail' }],
      },
      RECORD,
    );
    expect(set.status, await set.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, restricted.userId, profile.id)).status).toBe(201);

    const res = await api.request('PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
      ...w.as(restricted.userId),
      ifMatch: draft.revision,
      body: { fields: { departmentId: s.from } },
    });
    expect(res.status, await res.clone().text()).toBe(403);
    const stored = await withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT department_id FROM employment_payload_versions
        WHERE business_id=${draft.id}::uuid ORDER BY version_no DESC LIMIT 1`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { department_id: string }[];
    });
    expect(stored[0]!.department_id).toBe(s.to);
  });

  it('本人入口：绑定员工的 selfServiceButtons 含三个本人调动按钮；撤掉按钮即时生效；未绑定成员 403', async () => {
    const { w, world, restricted, api } = await scene('f141-self-buttons');
    const profile = async () => {
      const res = await api.request('GET', '/api/tenant/self-service/profile', w.as(restricted.userId));
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as { selfServiceButtons: { buttonCode: string; level: string }[] };
    };
    for (const { buttonCode, level } of EMPLOYEE_SELF_SERVICE_BUTTONS)
      expect((await profile()).selfServiceButtons, buttonCode).toContainEqual({ buttonCode, level });

    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
        DELETE FROM permission_profile_buttons WHERE button_code='Transfer.Self' AND profile_id IN
          (SELECT id FROM permission_profiles WHERE code=${EMPLOYEE_SELF_SERVICE_CODE})`),
    );
    const after = (await profile()).selfServiceButtons.map((b) => b.buttonCode);
    expect(after).not.toContain('Transfer.Self');
    expect(after).toContain('Employment.Create');

    const unbound = await w.member('未绑定成员');
    const res = await api.request('GET', '/api/tenant/self-service/profile', w.as(unbound));
    expect(res.status).toBe(403);
    expect(world).toBeDefined();
  });

  it('通用对象权限查询不叠加员工身份：只有员工身份的人对任职对象 403；读他人任职链 403 / 404', async () => {
    const { w, s, restricted, api } = await scene('f141-self-generic');
    const me = await api.request('GET', `/api/tenant/permission/me/objects/${RECORD}`, w.as(restricted.userId));
    expect(me.status).toBe(403);
    const other = await api.request(
      'GET',
      `/api/tenant/employment/employees/${s.subject.employeeId}/records`,
      w.as(restricted.userId),
    );
    expect([403, 404]).toContain(other.status);
  });
});
