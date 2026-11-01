/**
 * BE-10c AC-OA-28-pg（R2-T08 §14.1、DEC-196 全局锁序：员工 → 业务 → 组织 → 编制 → 审批实例，成员行在组织锁之后）：
 * 组织调整的审批事务（批量交接合席推进到最后同意）不申请组织锁；与入职按登录邮箱首次绑定异常管理员账号交错时不死锁。
 * 场景：首节点负责人单签（首节点有空席会拒绝提交，DEC-054）；第二节点会签（主体组织 HRBP 为空 → 外部异常管理员 U
 * 占一席；负责人一席），负责人先后同意首节点与本席后剩 U 的待办；
 * 由非发起人把 U 交接给负责人 → 合席 → 本节点办结 → 单据“审批通过 + 未执行”。同时入职一名员工，按 U 的邮箱绑定账号。
 * 锁序：交接先按 lockMany 锁申请单，再登记替代人（U 成员行 KEY SHARE），再锁实例。只在设了 TEST_DATABASE_URL 时运行。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { approverSource, ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import type { NodeInput } from './AC-APV-support.js';
import { flowWorld } from './AC-OA-approval-support.js';
import { rowsOf } from './support/f048.js';
import { settledOrBlocked, waitForBlocked } from './support/pg-interleave.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

const HEAD_FIRST: NodeInput = {
  key: 'head',
  name: '负责人审批',
  approver: approverSource('approval_subject_org_head'),
  formFields: ORG_ADJUSTMENT_FORM_FIELDS,
  exits: ['approve', 'disagree'],
};

const JOINT: NodeInput = {
  key: 'joint',
  name: '联合会签',
  kind: 'countersign',
  approvers: [approverSource('approval_subject_org_hrbp'), approverSource('approval_subject_org_head')],
  transitionRule: { type: 'all' },
  formFields: ORG_ADJUSTMENT_FORM_FIELDS,
  exits: ['approve', 'disagree'],
};

async function scene(label: string) {
  const email = `${label}-${randomUUID()}@example.com`;
  let sourceId = '';
  const w = await flowWorld(database().db, label, {
    nodes: [HEAD_FIRST, JOINT],
    process: async (world) => {
      const source = await createUser(world.db, { email, displayName: '外部异常管理员' }, cmd());
      await grantMembership(world.db, { tenantId: world.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
      sourceId = source.id;
      return { exceptionAdminUserId: source.id };
    },
  });
  await w.setOrgRoles(w.subject, { hrbp: null, head: w.head.employeeId });
  const { id } = await w.draft();
  await w.submitted(id);
  await w.acted(id, w.head, 'approve');
  await w.acted(id, w.head, 'approve');
  const view = await w.instance(id);
  expect(view.tasks.filter((t) => t.status === 'pending')).toEqual([
    expect.objectContaining({ assigneeUserId: sourceId }),
  ]);
  const target = await w.employee('待绑定员工');
  // 交接操作人不能是本单发起人（DEC-092 / DEC-329②，否则该实例被跳过 APPROVAL_ADMIN_SELF）
  const operator = await w.member(`交接操作人${randomUUID()}`);
  return {
    w,
    id,
    view,
    sourceId,
    target,
    handover: () =>
      w.request(operator, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: sourceId, toUserId: w.head.userId },
      }),
    hireWithSource: () =>
      w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${target.id}/businesses`, {
        ifMatch: target.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2020-01-01',
          fields: { departmentId: w.a },
          loginEmail: email,
        },
      }),
  };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** 两个请求都成功（无 40P01 / 409），结果与串行一致：单据 2 / 1、不入队，实例通过，U 已绑定入职员工。 */
async function expectSerialOutcome(f: Scene, handed: Response, hired: Response) {
  expect(handed.status, await handed.clone().text()).toBe(200);
  expect(hired.status, await hired.clone().text()).toBe(201);
  expect(await f.w.state(f.id)).toMatchObject({ approval: 2, execution: 1, queued: 0 });
  expect((await f.w.instance(f.id)).status).toBe('approved');
  const link = await withTenant(f.w.db, f.w.tenant.id, async (tx) =>
    rowsOf<{ employee_id: string }>(
      await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
        WHERE tenant_id=${f.w.tenant.id} AND user_id=${f.sourceId}::uuid`),
    ),
  );
  expect(link).toEqual([{ employee_id: f.target.id }]);
}

describe.runIf(realPostgres)('AC-OA-28-pg 组织调整审批事务 × 入职绑定：锁序一致、不取组织锁', () => {
  it('串行基准：交接合席后单据 2 / 1，再入职绑定', async () => {
    const f = await scene('oa28-serial');
    const handed = await f.handover();
    const hired = await f.hireWithSource();
    await expectSerialOutcome(f, handed, hired);
  });

  it('交接在业务锁（lockMany）上排队时，入职绑定不被挡住；放行后两边都完成', async () => {
    const f = await scene('oa28-business-first');
    let handed: Promise<Response> = Promise.resolve(new Response());
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM org_adjustments
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.id}::uuid FOR UPDATE`);
      handed = f.handover();
      await waitForBlocked(f.w.db, 1);
      hired = f.hireWithSource();
      expect(await settledOrBlocked(f.w.db, hired, 2)).toBe('settled');
    });
    await expectSerialOutcome(f, await handed, await hired);
  });

  it('交接持着成员行等实例锁时，入职绑定排在后面；放行后合席推进不申请组织锁，两边都完成', async () => {
    const f = await scene('oa28-instance-first');
    let handed: Promise<Response> = Promise.resolve(new Response());
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM approval_instances
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.view.id}::uuid FOR UPDATE`);
      handed = f.handover();
      await waitForBlocked(f.w.db, 1);
      hired = f.hireWithSource();
      await waitForBlocked(f.w.db, 2);
    });
    await expectSerialOutcome(f, await handed, await hired);
  });

  it('别的事务持组织锁时，交接合席推进到最后同意仍能完成（审批事务不取组织锁）', async () => {
    const f = await scene('oa28-org-lock');
    let handed: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await lockOrganizationSettings(barrier, f.w.tenant.id);
      handed = f.handover();
      expect(await settledOrBlocked(f.w.db, handed, 1)).toBe('settled');
    });
    expect((await handed).status).toBe(200);
    expect(await f.w.state(f.id)).toMatchObject({ approval: 2, execution: 1, queued: 0 });
  });
});
