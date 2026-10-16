/**
 * R2-T03 B2a / AC-DM-28 B-65：离职申请服务按发起方式分流（设计 §4B，DEC-283 预留）。
 * 服务层直接调用 createExitApplication（不经 HTTP；入口、门户按钮与配置页归 F-020）：
 * self / manager 只能走字段子集；发起人、被离职人、发起方式分开记录；最后节点同意前离职类型必须补齐；
 * 流程匹配输入含 initiation。
 */
import { randomUUID } from 'node:crypto';
import { sql, systemSettings, tenantSettingOverrides, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { createExitApplication, updateExitFields } from '../../apps/api/src/modules/employment/exit-application.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { gateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';
const MANAGER_SWITCH = 'exit.manager_initiation_enabled';

async function world(label: string) {
  const w = await gateWorld(database().db, label);
  const manager = (await w.hired('直线经理')).employee;
  const staff = await w.session.employee('被离职人');
  await w.session.business(
    staff.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.from.id, directManagerId: manager.id },
    },
    staff.revision,
  );
  const userOf = async (employeeId: string) =>
    (
      await w.sqlRows<{ userId: string }>(sql`SELECT user_id AS "userId" FROM permission_user_person_links
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`)
    )[0]!.userId;
  const ctx = async (userId: string, employeeId: string) => ({
    tenantId: w.session.tenant.id,
    userId,
    timezone: w.session.tenant.timezone,
    now: new Date('2026-10-06T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision: (await w.session.getEmployee(employeeId)).revision,
  });
  // 上下文先取好再开事务：PGlite 单连接，事务内不能再发 HTTP 读取
  const create = async (userId: string, input: Parameters<typeof createExitApplication>[2]) => {
    const context = await ctx(userId, input.employeeId);
    return withTenant(w.db, w.session.tenant.id, (tx) => createExitApplication(tx, context, input));
  };
  return { w, manager, staff, userOf, ctx, create };
}

const self = (employeeId: string, exit: object = { whereaboutsCode: 'startup' }) => ({
  employeeId,
  initiation: 'self' as const,
  mode: 'application' as const,
  lastWorkDate: LATER,
  exit,
});

describe('AC-DM-28 B-65 自助 / 经理代发的字段子集与身份关系', () => {
  it('self：缺 HR 字段可建单，原因缺省 personal，发起人 / 被离职人 / 发起方式分开记录并写审计', async () => {
    const { w, staff, userOf, create } = await world('app-self');
    const user = await userOf(staff.id);
    const created = await create(user, self(staff.id, { whereaboutsCode: 'startup', attachmentRefs: [randomUUID()] }));
    expect(created.status).toBe('draft');
    expect(await w.exitRow(created.id)).toMatchObject({
      initiator: 'self',
      initiator_user_id: user,
      employee_id: staff.id,
      reason_code: 'personal',
      whereabouts_code: 'startup',
      exit_type_code: null,
      mode: 'application',
    });
    const [audit] = await w.sqlRows<{ after: Record<string, unknown> }>(sql`SELECT after FROM audit_events
      WHERE tenant_id=${w.session.tenant.id} AND action='exit.request.create' AND object_id=${created.id}`);
    expect(audit?.after).toMatchObject({ initiation: 'self', initiatorUserId: user, employeeId: staff.id });
  });

  it('self 子集之外 400 且无写入：HR 字段、直接离职、去向缺失 / 非三选一、原因不在 personal / family', async () => {
    const { w, staff, userOf, create } = await world('app-self-reject');
    const user = await userOf(staff.id);
    const before = await w.stateOf(staff.id);
    const rejected = [
      [
        self(staff.id, { whereaboutsCode: 'startup', exitTypeCode: 'voluntary' }),
        'EXIT_FIELD_NOT_ALLOWED_FOR_INITIATION',
      ],
      [self(staff.id, { whereaboutsCode: 'startup', addToBlacklist: true }), 'EXIT_FIELD_NOT_ALLOWED_FOR_INITIATION'],
      [{ ...self(staff.id), mode: 'direct' as const }, 'EXIT_DIRECT_ONLY_HR'],
      [self(staff.id, {}), 'EXIT_WHEREABOUTS_REQUIRED'],
      [self(staff.id, { whereaboutsCode: 'family' }), 'EXIT_WHEREABOUTS_NOT_ALLOWED'],
      [self(staff.id, { whereaboutsCode: 'startup', reasonCode: 'nope' }), 'EXIT_REASON_NOT_ALLOWED'],
    ] as const;
    for (const [input, reason] of rejected)
      await expect(create(user, input), reason).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason },
      });
    expect(await w.stateOf(staff.id)).toEqual(before);
  });

  it('self 的 employeeId 必须等于本人绑定的员工，否则 403 无写入', async () => {
    const { w, manager, staff, userOf, create } = await world('app-self-other');
    const before = await w.stateOf(manager.id);
    await expect(create(await userOf(staff.id), self(manager.id))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await w.stateOf(manager.id)).toEqual(before);
  });

  it('manager：开关默认关 → 403；开启后非直线经理 404，直线经理成功并按经理本人记发起人', async () => {
    const { w, manager, staff, userOf, create } = await world('app-manager');
    const input = { ...self(staff.id), initiation: 'manager' as const };
    const managerUser = await userOf(manager.id);
    await expect(create(managerUser, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'EXIT_MANAGER_INITIATION_DISABLED' },
    });
    // 系统值由 F-020 seed；本批只认租户的有效覆盖，测试先补一条系统行（覆盖表有外键）
    await withPlatform(w.db, (tx) =>
      tx
        .insert(systemSettings)
        .values({ key: MANAGER_SWITCH, value: false, description: '经理代发离职开关', overridable: true })
        .onConflictDoNothing(),
    );
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.insert(tenantSettingOverrides).values({
        tenantId: w.session.tenant.id,
        key: MANAGER_SWITCH,
        value: true,
        active: true,
        revision: 1,
        updatedBy: w.session.user.id,
      }),
    );
    const stranger = (await w.hired('路人')).employee;
    await expect(create(await userOf(stranger.id), input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const created = await create(managerUser, input);
    expect(await w.exitRow(created.id)).toMatchObject({
      initiator: 'manager',
      initiator_user_id: managerUser,
      employee_id: staff.id,
    });
  });

  it('confirmed 前离职类型必须补齐：缺则最后节点同意 409 EXIT_HR_FIELDS_REQUIRED（仍审批中），HR 补齐后通过', async () => {
    const { w, staff, userOf, ctx, create } = await world('app-hr-fields');
    const user = await userOf(staff.id);
    const created = await create(user, self(staff.id));
    const draft = await w.business(created.id);
    const submitCtx = { ...(await ctx(user, staff.id)), expectedRevision: draft.revision };
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      transitionEmployment(tx, submitCtx, { id: created.id, action: 'submit' }),
    );
    await expect(w.approve(created, '2026-10-06T02:00:00Z')).rejects.toMatchObject({
      details: { reason: 'EXIT_HR_FIELDS_REQUIRED' },
    });
    const pending = await w.business(created.id);
    expect(pending.status).toBe('in_review');
    const hrCtx = { ...(await ctx(w.session.user.id, staff.id)), expectedRevision: pending.revision };
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      updateExitFields(tx, hrCtx, created.id, { exitTypeCode: 'voluntary' }),
    );
    expect(await w.approve(created, '2026-10-06T02:00:00Z')).toMatchObject({ status: 'approved' });
  });

  it('流程匹配输入含 initiation（发起条件字段 business.initiation）', async () => {
    const { w, staff, userOf, ctx, create } = await world('app-initiation');
    const created = await create(await userOf(staff.id), self(staff.id));
    const context = { ...(await ctx(w.session.user.id, staff.id)), expectedRevision: 0 };
    const snapshot = await withTenant(w.db, w.session.tenant.id, (tx) =>
      ADAPTERS.employment.snapshot(tx, context, created.id),
    );
    expect(snapshot.conditionValues).toMatchObject({ 'business.initiation': 'self' });
  });
});
