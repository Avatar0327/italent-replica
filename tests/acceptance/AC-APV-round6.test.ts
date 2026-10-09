/**
 * PR #35 第六轮修改清单（astra 五审 R5-1～R5-5 + 顺带补测）。
 * R5-3 回退的租户管理员候选按游标分批扫描，不在资格过滤前截断；顺带补测：停用接管中途失败整体回滚（outbox 为零）、
 * R4-1 非空旧游标的撤权裁剪、tenant_account_active 跨租户负例。
 * R5-1（全局停用与本人审批交错）、R5-2（双租户重新激活与派单交错）、R5-4（停用最终回滚时通知意图不丢）、
 * R5-5（R4-5 的 SHARE 屏障）在 AC-APV-concurrency-pg.test.ts（真 PostgreSQL）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { eq, permissionUserPersonLinks, revokeMembership, sql, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

type Scene = Awaited<ReturnType<typeof transferScene>>;
interface HandoverResult {
  tasks: number;
  skipped: { instanceId: string; reason: string }[];
  unlisted: number;
  remaining: boolean;
  nextCursor: string | null;
}

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

function denying(predicate: (resource: string) => boolean): Authorizer {
  return (request) => !predicate(String(request.resource ?? ''));
}

async function membershipRevision(w: ApprovalWorld, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  return Number(rowsOf<{ revision: number }>(rows)[0]!.revision);
}

async function revoke(w: ApprovalWorld, userId: string) {
  const expectedRevision = await membershipRevision(w, userId);
  return revokeMembership(w.db, { tenantId: w.tenant.id, userId, expectedRevision }, cmd());
}

/** 两节点调动流程，第二节点 HRBP 为空 → 异常管理员（默认 w.exceptionAdmin）待办。 */
async function exceptionWorld(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.setOrgRoles(s.to, { hrbp: null });
  await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
  return { w, s };
}

async function exceptionInstance(w: ApprovalWorld, s: Scene, initiator = w.hr.id, employeeId = s.subject.employeeId) {
  const draft = await w.application(employeeId, { departmentId: s.to }, { actor: initiator });
  let view = await w.submit(draft, initiator);
  view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
  expect(current(view)).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
  return view;
}

function handover(w: ApprovalWorld, body: Record<string, unknown>) {
  return w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, { ifMatch: 0, body });
}

async function takeoverAudits(w: ApprovalWorld) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ object_id: string }>(
      await tx.execute(sql`SELECT object_id FROM audit_events WHERE tenant_id=${w.tenant.id}
        AND action='approval.instance.exception_admin_takeover'`),
    ),
  );
}

describe('R5-3（P2）：回退的租户管理员候选按游标分批扫描，直到找到合格者或真正用尽', () => {
  /** 可信夹具：50 个更早开通、成员关系有效、但全局账号已停用的租户管理员。 */
  async function disabledAdmins(w: ApprovalWorld, count: number) {
    const ids = Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    await withPlatform(w.db, async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.execute(sql`INSERT INTO users (id,email,display_name,status)
          VALUES (${id}::uuid,${`apv-r53-${i}-${w.tenant.id}@example.com`},${`已停用管理员${i}`},'disabled')`);
      }
    });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.execute(sql`INSERT INTO tenant_memberships (tenant_id,user_id) VALUES (${w.tenant.id},${id}::uuid)`);
        await tx.execute(sql`INSERT INTO permission_admins (tenant_id,user_id,role,created_at,updated_at)
          VALUES (${w.tenant.id},${id}::uuid,'tenant_admin',
            now() - interval '1 day' + ${i}::int * interval '1 second',now())`);
      }
    });
  }

  it('前 50 位租户管理员都不合格（账号已停用）、第 51 位合格：替代人不能接手时转给第 51 位', async () => {
    const { w, s } = await exceptionWorld('apv-r53');
    const successor = await w.member('接任的异常管理员');
    const view = await exceptionInstance(w, s, successor);
    const handed = await w.json<HandoverResult>(
      await handover(w, { fromUserId: w.exceptionAdmin, toUserId: successor }),
    );
    expect(handed.skipped).toEqual([{ instanceId: view.id, reason: 'APPROVAL_EXCEPTION_ADMIN_SELF' }]);
    await disabledAdmins(w, 50);
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    await revoke(w, w.exceptionAdmin);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.hr.id, isExceptionAdmin: true });
  });
});

/**
 * R6-4：确定性构造“第一单可接手、第二单无人接手”。两张单都由 HR 发起（交接时按 DEC-092 都跳过），异动对象是两位
 * 未绑账号的员工；编号定下来后，把替代人的账号绑到接管顺序靠后那张单的异动对象上——替代人在那张单上是异动本人（回避），
 * 租户又没有管理员，无人接手；靠前的那张单替代人可接手。接管按全局取锁顺序（异动员工, 实例编号，F-008 / R6-3），
 * 两张单的异动员工不同，先后即员工编号的先后，由构造保证，不靠随机重试。
 */
async function orderedPair(w: ApprovalWorld, s: Scene, successor: string) {
  const employees: string[] = [];
  for (const name of ['甲', '乙']) {
    const employee = await w.employee(`异动对象${name}`);
    await w.hire(employee.id, { departmentId: s.from });
    employees.push(employee.id);
  }
  // 小写 UUID 文本的字典序与 PostgreSQL uuid 的排序一致。
  const [firstId, secondId] = employees.sort();
  // 入职时按 DEC-140 自动建了合成账号的绑定；可信夹具把它换成替代人的账号（同一事务内先删后插）。F-048（DEC-329⑤）起回避判定
  // 读发起时冻结的账号，所以必须在发起之前换绑，替代人才是那张单上的异动本人。
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.delete(permissionUserPersonLinks).where(eq(permissionUserPersonLinks.employeeId, secondId!));
    await tx
      .insert(permissionUserPersonLinks)
      .values({ tenantId: w.tenant.id, userId: successor, employeeId: secondId! });
  });
  const takeable = await exceptionInstance(w, s, w.hr.id, firstId!);
  const failing = await exceptionInstance(w, s, w.hr.id, secondId!);
  return { takeable, failing };
}

describe('顺带补测：停用接管中途失败，整体回滚', () => {
  it('第一单已转给替代人、第二单无人接手：停用被拒，两单都不动，没有接管审计、outbox 为零', async () => {
    const { w, s } = await exceptionWorld('apv-r6-rollback');
    const successor = await w.member('接任的异常管理员');
    // 接管按（异动员工, 实例编号）顺序：第一单替代人可接手，第二单替代人是异动本人（回避）且租户没有管理员 → 无人接手。
    const { takeable, failing } = await orderedPair(w, s, successor);
    await w.json(await handover(w, { fromUserId: w.exceptionAdmin, toUserId: successor }));
    const revision = await membershipRevision(w, w.exceptionAdmin);
    const error = await revoke(w, w.exceptionAdmin).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { reason: 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE' } });
    expect(await membershipRevision(w, w.exceptionAdmin)).toBe(revision);
    for (const id of [takeable.id, failing.id]) {
      expect(current(await w.detail(id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
    }
    expect(await takeoverAudits(w)).toHaveLength(0);
    const [outbox] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM approval_outbox WHERE tenant_id=${w.tenant.id}
          AND event_type='approval.task.transferred'
          AND object_id IN (${takeable.id}::uuid,${failing.id}::uuid)`),
      ),
    );
    expect(Number(outbox!.n)).toBe(0);
  });
});

describe('顺带补测：R4-1 非空旧游标的撤权裁剪', () => {
  it('首次结果带游标（200 个跳过项后还有剩余）→ 撤销实例转交权限 → 同键重放：游标与编号都不再给出', async () => {
    const { w, s } = await exceptionWorld('apv-r6-cursor');
    const applicant = await w.member('发起人');
    const legal = await exceptionInstance(w, s, applicant);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO approval_instances
        (id,tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,subject_employee_id,
         initiator_user_id,process_code,title,business_version,status,current_node_key,round,revision,
         created_at,updated_at)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,i.tenant_id,i.process_id,i.version_id,
          i.approval_type,i.object_code,i.business_type,gen_random_uuid(),i.subject_employee_id,${w.hr.id}::uuid,
          i.process_code,i.title,i.business_version,'running','in_hrbp',1,1,now(),now()
        FROM approval_instances i, generate_series(1,200) g
        WHERE i.tenant_id=${w.tenant.id} AND i.id=${legal.id}::uuid`);
      await tx.execute(sql`INSERT INTO approval_tasks
        (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,is_exception_admin,created_at)
        SELECT gen_random_uuid(),${w.tenant.id},('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,1,1,
          'in_hrbp',${w.exceptionAdmin}::uuid,'exception_admin','pending',true,now()
        FROM generate_series(1,200) g`);
    });
    const successor = await w.member('新异常管理员');
    const options = {
      ...w.as(w.hr.id),
      ifMatch: 0,
      idempotencyKey: 'r6-cursor-handover',
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    };
    const first = await w.json<HandoverResult>(
      await w.api.request('POST', `${BASE}/exception-admins/handover`, options),
    );
    expect(first).toMatchObject({ tasks: 0, remaining: true });
    expect(first.skipped).toHaveLength(200);
    expect(first.nextCursor).toBe('00000000-0000-4000-8000-000000000200');
    const narrowed = tenantApi(w.db, {
      authorize: denying((resource) => resource.includes('ApprovalInstance')),
      clock: w.clock,
    });
    const replay = await narrowed.request('POST', `${BASE}/exception-admins/handover`, options);
    const text = await replay.text();
    expect(replay.status, text).toBe(200);
    expect(text).not.toContain('00000000-0000-4000-8000-');
    expect(JSON.parse(text)).toMatchObject({ skipped: [], unlisted: first.unlisted + 200, nextCursor: null });
  });
});

describe('顺带补测：tenant_account_active 只对当前租户的成员作答', () => {
  it('其他租户的有效用户在本租户上下文里一律 false；本租户有效成员为 true', async () => {
    const a = await approvalWorld(database().db, 'apv-r6-account-a');
    const b = await approvalWorld(database().db, 'apv-r6-account-b');
    const answers = await withTenant(a.db, a.tenant.id, async (tx) =>
      rowsOf<{ own: boolean; other: boolean }>(
        await tx.execute(sql`SELECT tenant_account_active(${a.hr.id}::uuid) AS own,
          tenant_account_active(${b.hr.id}::uuid) AS other`),
      ),
    );
    expect(answers[0]).toEqual({ own: true, other: false });
  });
});
