/**
 * F-048 PR-1 主体冻结（docs/08_设计/F-048_审批多主体回避_设计.md §2.2、§5，测试 T1）：
 * 发起冻结第 1 轮、重提写新一轮（只增不减、账号按当时绑定重新取）、存量实例回退、未知 / 外租户员工与上限拒绝、
 * 冻结行不可改。集合审批的业务尚未接入（R3-T04），用测试适配器给任职业务临时挂 subjects 映射。
 */
import { randomUUID } from 'node:crypto';
import { eq, permissionUserPersonLinks, sql, users, withPlatform, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTERS, type BusinessAdapter } from '../../apps/api/src/modules/approval/adapters.js';
import type { ApprovalContext } from '../../apps/api/src/modules/approval/context.js';
import { loadRecusalFacts } from '../../apps/api/src/modules/approval/subjects.js';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { runSubjectAdapterContract } from './support/approval-subjects-contract.js';

const database = useTestDb();
const employment = ADAPTERS.employment as BusinessAdapter;

/** 测试适配器：给任职业务临时挂“对象 → 主体”映射，用例结束即移除，不进产品代码。 */
function mapSubjects(ids: () => readonly string[]) {
  (employment as { subjects?: BusinessAdapter['subjects'] }).subjects = async () => ids();
}
afterEach(() => {
  delete (employment as { subjects?: unknown }).subjects;
});

interface FrozenRow {
  round: number;
  employee_id: string;
  user_id: string | null;
}

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

async function frozen(w: ApprovalWorld, instanceId: string): Promise<FrozenRow[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<FrozenRow>(
      await tx.execute(sql`SELECT round, employee_id::text, user_id::text FROM approval_instance_subjects
        WHERE tenant_id=${w.tenant.id} AND instance_id=${instanceId}::uuid ORDER BY round, employee_id`),
    ),
  );
}

async function instanceCount(w: ApprovalWorld, businessId: string): Promise<number> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM approval_instances
        WHERE tenant_id=${w.tenant.id} AND business_id=${businessId}::uuid`),
    );
    return Number(row?.n ?? 0);
  });
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

const pendingOf = (view: InstanceView) => view.tasks.filter((task) => task.status === 'pending');

/** 只有一个“调出部门负责人”节点的已发布调动流程。 */
async function scene(w: ApprovalWorld) {
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [{ key: 'out_head', approver: 'latest_record_department_head' }] });
  return s;
}

/** 绑定账号（可信夹具：模拟建档 / 入职的首次绑定）。 */
async function bind(w: ApprovalWorld, employeeId: string, name: string): Promise<string> {
  const userId = await w.member(name);
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.insert(permissionUserPersonLinks).values({ tenantId: w.tenant.id, userId, employeeId }),
  );
  return userId;
}

async function rejectAndResubmit(w: ApprovalWorld, view: InstanceView, approver: string, businessId: string) {
  const returned = await w.json<InstanceView>(
    await w.taskAction(approver, pendingOf(view)[0]!.id, 'reject', view.revision),
  );
  expect(returned.status).toBe('returned');
  const business = await w.business(businessId);
  await w.json(await w.submitRaw({ id: businessId, revision: business.revision }));
  return w.instanceOf(businessId);
}

describe('T1 发起冻结第 1 轮', () => {
  it('单主体业务：冻结异动员工本人与其账号，写冻结审计', async () => {
    const w = await approvalWorld(database().db, 'f048-freeze-single');
    const s = await scene(w);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(await frozen(w, view.id)).toEqual([
      { round: 1, employee_id: s.subject.employeeId, user_id: s.subject.userId },
    ]);
    const audits = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ after: Record<string, unknown> }>(
        await tx.execute(sql`SELECT after FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND action='approval.instance.subjects_freeze' AND object_id=${view.id}`),
      ),
    );
    expect(audits.map((row) => row.after)).toEqual([{ round: 1, subjectsFrozen: 1 }]);
  });

  it('集合映射：未绑定账号的员工冻结为空账号；账号已停用的照样冻结（不看状态，Q05）', async () => {
    const w = await approvalWorld(database().db, 'f048-freeze-collective');
    const s = await scene(w);
    const unbound = await w.employee('未绑定员工');
    const disabledEmployee = await w.employee('账号停用员工');
    const disabledUser = await bind(w, disabledEmployee.id, '停用账号');
    await withPlatform(w.db, (tx) => tx.update(users).set({ status: 'disabled' }).where(eq(users.id, disabledUser)));
    mapSubjects(() => [unbound.id.toUpperCase(), disabledEmployee.id, s.subject.employeeId]);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const expected = [
      { round: 1, employee_id: unbound.id, user_id: null },
      { round: 1, employee_id: disabledEmployee.id, user_id: disabledUser },
      { round: 1, employee_id: s.subject.employeeId, user_id: s.subject.userId },
    ].sort((a, b) => a.employee_id.localeCompare(b.employee_id));
    expect(await frozen(w, view.id)).toEqual(expected);
  });
});

describe('T1 重提写新一轮：只增不减，账号按当时绑定重新取（DEC-329⑤）', () => {
  it('冻结后首次绑定：本轮不变，重提后新一轮带上新账号；移出的员工在后续轮次仍保留', async () => {
    const w = await approvalWorld(database().db, 'f048-resubmit');
    const s = await scene(w);
    const late = await w.employee('后绑定员工');
    let mapped: string[] = [late.id];
    mapSubjects(() => mapped);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    const lateUser = await bind(w, late.id, '后绑定账号');
    // 冻结之后的首次绑定不追溯：第 1 轮仍是空账号
    expect((await frozen(w, view.id)).find((row) => row.employee_id === late.id)?.user_id).toBeNull();
    view = await rejectAndResubmit(w, view, s.outHead.userId, draft.id);
    mapped = []; // 第 3 轮适配器不再给出该员工
    view = await rejectAndResubmit(w, view, s.outHead.userId, draft.id);
    const rows = await frozen(w, view.id);
    const ofLate = rows.filter((row) => row.employee_id === late.id);
    expect(ofLate).toEqual([
      { round: 1, employee_id: late.id, user_id: null },
      { round: 2, employee_id: late.id, user_id: lateUser },
      { round: 3, employee_id: late.id, user_id: lateUser },
    ]);
    expect(rows.filter((row) => row.employee_id === s.subject.employeeId).map((row) => row.round)).toEqual([1, 2, 3]);
    const facts = await withTenant(w.db, w.tenant.id, async (tx) =>
      loadRecusalFacts(tx, w.tenant.id, {
        id: view.id,
        initiatorUserId: w.hr.id,
        subjectEmployeeId: s.subject.employeeId,
      }),
    );
    expect([...facts.subjectEmployeeIds].sort()).toEqual([late.id, s.subject.employeeId].sort());
    expect([...facts.subjectUserIds].sort()).toEqual([lateUser, s.subject.userId].sort());
    expect(facts.primaryUserId).toBe(s.subject.userId);
  });
});

describe('T1 存量实例回退（设计 §2.1）', () => {
  it('没有冻结行的实例：主体集合为单主体，单主体账号沿用实时绑定', async () => {
    const w = await approvalWorld(database().db, 'f048-legacy');
    const s = await transferScene(w);
    const facts = await withTenant(w.db, w.tenant.id, async (tx) =>
      loadRecusalFacts(tx, w.tenant.id, {
        id: randomUUID(),
        initiatorUserId: w.hr.id,
        subjectEmployeeId: s.subject.employeeId,
      }),
    );
    expect([...facts.subjectEmployeeIds]).toEqual([s.subject.employeeId]);
    expect([...facts.subjectUserIds]).toEqual([s.subject.userId]);
    expect(facts.primaryUserId).toBe(s.subject.userId);
  });
});

describe('T1 负例：整单拒绝、不写入', () => {
  async function rejected(label: string, ids: () => readonly string[], reason: string) {
    const w = await approvalWorld(database().db, label);
    const s = await scene(w);
    mapSubjects(ids);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const before = await w.business(draft.id);
    const response = await w.submitRaw(draft);
    expect(await reasonOf(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', reason });
    expect(await w.business(draft.id)).toMatchObject({ status: before.status, revision: before.revision });
    expect(await instanceCount(w, draft.id)).toBe(0);
    const count = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_instance_subjects`)),
    );
    expect(Number(count[0]?.n)).toBe(0);
    return w;
  }

  it('适配器给出不存在的员工 → 400 APPROVAL_SUBJECT_UNKNOWN', async () => {
    await rejected('f048-unknown', () => [randomUUID()], 'APPROVAL_SUBJECT_UNKNOWN');
  });

  it('适配器给出格式不合法的编号 → 400 APPROVAL_SUBJECT_UNKNOWN', async () => {
    await rejected('f048-malformed', () => ['not-a-uuid'], 'APPROVAL_SUBJECT_UNKNOWN');
  });

  it('适配器给出其他租户的员工 → 400 APPROVAL_SUBJECT_UNKNOWN', async () => {
    const other = await approvalWorld(database().db, 'f048-other-tenant-src');
    const foreign = await other.employee('外租户员工');
    await rejected('f048-other-tenant', () => [foreign.id], 'APPROVAL_SUBJECT_UNKNOWN');
  });

  it('超过每实例 10,000 人 → 400 APPROVAL_SUBJECTS_TOO_MANY', async () => {
    const many = Array.from({ length: 10_001 }, () => randomUUID());
    await rejected('f048-too-many', () => many, 'APPROVAL_SUBJECTS_TOO_MANY');
  });
});

describe('T1 冻结行不可改', () => {
  it('应用角色（只授予 SELECT / INSERT）：UPDATE / DELETE 被拒绝，行内容不变', async () => {
    const w = await approvalWorld(database().db, 'f048-immutable');
    const s = await scene(w);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const before = await frozen(w, view.id);
    await expect(
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE approval_instance_subjects SET user_id=NULL WHERE instance_id=${view.id}::uuid`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`DELETE FROM approval_instance_subjects WHERE instance_id=${view.id}::uuid`),
      ),
    ).rejects.toThrow();
    expect(await frozen(w, view.id)).toEqual(before);
  });

  it('表属主（有改删权限）的 UPDATE / DELETE / TRUNCATE 也被只追加触发器拒绝（55000），行内容不变', async () => {
    const w = await approvalWorld(database().db, 'f048-immutable-owner');
    const s = await scene(w);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const before = await frozen(w, view.id);
    const statements = [
      sql`UPDATE approval_instance_subjects SET user_id=NULL WHERE instance_id=${view.id}::uuid`,
      sql`DELETE FROM approval_instance_subjects WHERE instance_id=${view.id}::uuid`,
      sql`TRUNCATE approval_instance_subjects`,
    ];
    for (const statement of statements) {
      const error = await w.db
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
          await tx.execute(statement);
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(pgErrorCode(error)).toBe('55000');
    }
    expect(await frozen(w, view.id)).toEqual(before);
  });
});

// 契约套件自测：一个按固定集合映射的测试适配器（集合业务接入时换成真实适配器）
runSubjectAdapterContract('测试适配器（固定集合）', async () => {
  const w = await approvalWorld(database().db, 'f048-contract');
  const a = await w.employee('对象一');
  const b = await w.employee('对象二');
  const ctx = { tenantId: w.tenant.id, userId: w.hr.id, now: new Date(), commandId: '', expectedRevision: 0 };
  return {
    db: w.db,
    tenantId: w.tenant.id,
    ctx: ctx as unknown as ApprovalContext,
    businessId: randomUUID(),
    expected: [a.id, b.id],
    subjects: async () => [a.id, b.id, a.id],
  };
});
