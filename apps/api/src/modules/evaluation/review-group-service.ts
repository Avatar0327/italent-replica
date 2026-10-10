/**
 * 评审组（`TEvaluation.ReviewGroup`）的读写服务（设计 §3.2、§5.1、§8）：
 * - 所属组织必填手选，须存在且在操作人 TEvaluation 范围内（DEC-082 / DEC-324②，范围外与不存在同一 404），读写同一谓词；
 * - 成员整组编辑，组长恰好 1 个、不重复；新增的成员须在人员范围内，集合里原有的范围外成员原样保留（person-refs.ts）；
 * - 编码租户内唯一；被引用拒删的钩子位见 usage.ts（B5 登记）。
 * 每个写入口在命令台账的同一事务里写业务与审计（DEC-019 / 216）。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { scopeAllows } from '../permission/module-access.js';
import type * as input from './input.js';
import { assertNewPersonRefs, loadEmployees, presentPersonRefs, type PersonRefAccess } from './person-refs.js';
import { type Tracked, view } from './read-model.js';
import type { View } from './route-support.js';
import { audit, bumped, guardUnique, lockEditable, rowsOf, type WriteContext } from './store.js';
import { rejectInUse } from './usage.js';

export interface MemberInput {
  readonly employeeId: string;
  readonly isLeader: boolean;
}
export type ReviewGroupView = Tracked & {
  readonly code: string;
  readonly name: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly enabled: boolean;
  readonly members: MemberInput[];
};

const codeExists = () => new AppError('CONFLICT', '编码重复，请重新输入', { reason: 'DUPLICATE' });

/** 组长恰好 1 个、成员不重复（对完整集合校验；与成员是否在范围内无关）。 */
export function checkMembers(members: readonly MemberInput[]): void {
  if (new Set(members.map((m) => m.employeeId)).size !== members.length) {
    throw new AppError('VALIDATION_FAILED', '成员不能重复', { reason: 'REVIEW_GROUP_MEMBER_DUPLICATE' });
  }
  if (members.filter((m) => m.isLeader).length !== 1) {
    throw new AppError('VALIDATION_FAILED', '评审组须恰好有 1 个组长', { reason: 'REVIEW_GROUP_LEADER_REQUIRED' });
  }
}

/** 所属组织：须存在且在操作人范围内；不存在与范围外同一个 404。 */
async function requireOwnerOrg(tx: Tx, ctx: WriteContext, orgId: string): Promise<void> {
  const found = rowsOf(
    await tx.execute(sql`SELECT 1 FROM org_objects WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orgId}::uuid`),
  );
  if (!found.length || !scopeAllows(ctx.scope, { orgId })) throw new AppError('NOT_FOUND', '所属组织不存在');
}

/** 读出成员（按提交顺序）并挂到评审组视图上。 */
export async function withMembers(
  tx: Tx,
  tenantId: string,
  rows: Record<string, unknown>[],
): Promise<ReviewGroupView[]> {
  if (!rows.length) return [];
  const groupIds = rows.map((row) => row.id as string);
  const found = rowsOf<{ group_id: string; employee_id: string; is_leader: boolean }>(
    await tx.execute(sql`SELECT group_id, employee_id, is_leader FROM ev_review_members
      WHERE tenant_id = ${tenantId}::uuid AND group_id = ANY(${`{${groupIds.join(',')}}`}::uuid[])
      ORDER BY group_id, seq`),
  );
  return rows.map((row) => ({
    ...view<Omit<ReviewGroupView, 'members'>>(row),
    members: found
      .filter((member) => member.group_id === row.id)
      .map((member) => ({ employeeId: member.employee_id, isLeader: member.is_leader })),
  }));
}

export async function loadGroup(tx: Tx, tenantId: string, id: string): Promise<ReviewGroupView> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT * FROM ev_review_groups WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`),
  );
  return (await withMembers(tx, tenantId, rows))[0]!;
}

/** 呈现：成员挂上人员引用出口（范围内 姓名 + 工号；范围外只有姓名；规则见 person-refs.ts）。 */
export async function presentGroups(
  tx: Tx,
  tenantId: string,
  access: PersonRefAccess,
  views: readonly View[],
): Promise<View[]> {
  // 路由注册器按 View 传入（读出的就是 withMembers 的结果）
  const groups = views as readonly ReviewGroupView[];
  const refs = await presentPersonRefs(
    tx,
    tenantId,
    access,
    groups.flatMap((group) => group.members.map((member) => member.employeeId)),
  );
  return groups.map((group) => ({
    ...group,
    members: group.members.map((member) => ({ ...member, ...refs.get(member.employeeId) })),
  }));
}

/**
 * 审计快照：成员只含员工 ID、当时姓名与组长标记（范围外成员同口径：ID 与姓名，不带其他字段，DEC-331① / DEC-339②）。
 * 姓名在业务事务内冻结，改名后历史日志仍是当时的值；读取时不再按查看人的员工信息姓名字段权二次裁剪
 * （TODO(审计成员姓名投影)：需 audit/visibility.ts 的联合路径裁剪，属共享登记，已在 PR 描述报总编排）。
 */
async function auditSnapshot(tx: Tx, tenantId: string, group: ReviewGroupView) {
  const names = new Map(
    (
      await loadEmployees(
        tx,
        tenantId,
        group.members.map((member) => member.employeeId),
      )
    ).map((row) => [row.id, row.name]),
  );
  return {
    ...group,
    members: group.members.map((member) => ({
      employeeId: member.employeeId,
      employeeName: names.get(member.employeeId) ?? null,
      isLeader: member.isLeader,
    })),
  };
}

async function replaceMembers(tx: Tx, ctx: WriteContext, groupId: string, members: readonly MemberInput[]) {
  await tx.execute(
    sql`DELETE FROM ev_review_members WHERE tenant_id = ${ctx.tenantId}::uuid AND group_id = ${groupId}::uuid`,
  );
  for (const [seq, member] of members.entries()) {
    await tx.execute(sql`INSERT INTO ev_review_members (tenant_id, group_id, employee_id, is_leader, seq)
      VALUES (${ctx.tenantId}, ${groupId}, ${member.employeeId}, ${member.isLeader}, ${seq})`);
  }
}

export async function createReviewGroup(tx: Tx, ctx: WriteContext, body: input.ReviewGroupCreate) {
  checkMembers(body.members);
  await requireOwnerOrg(tx, ctx, body.ownerOrgId);
  await assertNewPersonRefs(
    tx,
    ctx.persons!,
    body.members.map((member) => member.employeeId),
  );
  const now = ctx.now.toISOString();
  const result = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ev_review_groups
          (tenant_id, code, name, owner_id, owner_org_id, enabled, created_by, created_at, updated_at)
        VALUES (${ctx.tenantId}, ${body.code}, ${body.name}, ${ctx.userId}, ${body.ownerOrgId}, ${body.enabled ?? true},
          ${ctx.userId}, ${now}, ${now}) RETURNING id`),
    codeExists,
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  await replaceMembers(tx, ctx, id, body.members);
  const after = await loadGroup(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'reviewGroup', 'create', id, {
    before: null,
    after: await auditSnapshot(tx, ctx.tenantId, after),
    orgId: after.ownerOrgId,
  });
  return after;
}

const COLUMNS = { code: 'code', name: 'name', enabled: 'enabled', ownerOrgId: 'owner_org_id' } as const;

export async function updateReviewGroup(tx: Tx, ctx: WriteContext, id: string, body: input.ReviewGroupPatch) {
  const row = await lockEditable(tx, ctx, 'reviewGroup', id);
  const before = await loadGroup(tx, ctx.tenantId, id);
  if (body.members) checkMembers(body.members);
  // 改所属组织：新组织同样须在范围内（DEC-082）；没改就不重判
  if (body.ownerOrgId !== undefined && body.ownerOrgId !== row.owner_org_id) {
    await requireOwnerOrg(tx, ctx, body.ownerOrgId);
  }
  if (body.members) {
    // 只校验新增的 ID；原有的（含范围外的）原样保留，不重新校验可见性
    const existing = new Set(before.members.map((member) => member.employeeId));
    const added = body.members.map((member) => member.employeeId).filter((employeeId) => !existing.has(employeeId));
    await assertNewPersonRefs(tx, ctx.persons!, added);
  }
  const bump = bumped(ctx);
  const sets = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[])
    .filter((field) => body[field] !== undefined)
    .map((field) => sql`${sql.identifier(COLUMNS[field])} = ${body[field] as never}`);
  sets.push(sql`revision = ${bump.revision}`, sql`updated_at = ${bump.updatedAt}`);
  await guardUnique(
    () =>
      tx.execute(sql`UPDATE ev_review_groups SET ${sql.join(sets, sql`, `)}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`),
    codeExists,
  );
  if (body.members) await replaceMembers(tx, ctx, id, body.members);
  const after = await loadGroup(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'reviewGroup', 'update', id, {
    before: await auditSnapshot(tx, ctx.tenantId, before),
    after: await auditSnapshot(tx, ctx.tenantId, after),
    orgId: after.ownerOrgId,
  });
  return after;
}

export async function deleteReviewGroup(tx: Tx, ctx: WriteContext, id: string) {
  await lockEditable(tx, ctx, 'reviewGroup', id);
  // B5 登记“被评定活动 / 场次引用”（usage.ts 钩子位）
  await rejectInUse(tx, ctx, 'reviewGroup', id);
  const before = await loadGroup(tx, ctx.tenantId, id);
  // 成员随评审组删除（外键 CASCADE），删除快照连同成员写进审计
  await tx.execute(sql`DELETE FROM ev_review_groups WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'reviewGroup', 'delete', id, {
    before: await auditSnapshot(tx, ctx.tenantId, before),
    after: null,
    orgId: before.ownerOrgId,
  });
  return before;
}
