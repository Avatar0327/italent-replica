/**
 * 审批人表达式解析（REQ-APV-002 R2/R3）：调出 / 调入的区分靠“从哪条任职记录取部门”；
 * 组织的负责人、HRBP 是结构化人员引用（REQ-ORG-001 R4），人员再经账号绑定落到可审批的用户。
 */
import { sql, type Tx } from '@italent/db';
import {
  avoidSelfExceptionAdmin,
  isSelf,
  type ApproverExpression,
  type Candidate,
  type ExceptionAdminChoice,
  type RoutingFacts,
} from '@italent/domain';
import { findCurrentRecord } from '../employment/read-model.js';
import { rowsOf } from './context.js';

export interface RoutingSubject {
  readonly tenantId: string;
  readonly asOf: string;
  readonly initiatorUserId: string;
  readonly subjectEmployeeId: string | null;
  readonly latestDepartmentId: string | null;
  readonly recordDepartmentId: string | null;
  /** 同一次推进内的查询缓存（结果只依赖本主体的员工、部门与业务日期，X-20）。 */
  readonly cache?: Map<string, Promise<unknown>>;
}

/** 资格判定只需要租户与业务日期（查询缓存可选）。 */
export type EligibilityScope = Pick<RoutingSubject, 'tenantId' | 'asOf' | 'cache'>;

export function memo<T>(subject: Pick<RoutingSubject, 'cache'>, key: string, load: () => Promise<T>): Promise<T> {
  if (!subject.cache) return load();
  const hit = subject.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const value = load();
  subject.cache.set(key, value);
  return value;
}

const NOBODY: Candidate = { personId: null, userId: null };

/**
 * 人员的有效账号：账号绑定（DEC-128：用户与人员一一对应、由建档 / 入职绑定）、成员关系有效且全局账号未停用（R4-3）。
 * 只用于识别（异动本人、通知接收人等）；审批候选另经 isEligibleApprover 复核并取派单闸（candidateOf）。
 * 解析到没有账号或账号已停用的人员按“审批人为空”处理（DEC-098）。
 * TODO(需取证 Q-M0-44)：在职但没有系统账号 / 账号已停用的人员被解析为审批人时原站怎么处理，未取证。
 */
export async function userOfPerson(tx: Tx, tenantId: string, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const [row] = rowsOf<{ user_id: string }>(
    await tx.execute(sql`SELECT l.user_id FROM permission_user_person_links l
      JOIN tenant_memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id AND m.status='active'
      WHERE l.tenant_id=${tenantId} AND l.employee_id=${personId}::uuid AND tenant_account_active(l.user_id)
      LIMIT 1`),
  );
  return row?.user_id ?? null;
}

/**
 * 派单闸的键：租户 × 用户（事务级咨询锁，键里带租户，各租户互不影响）。R6-1：两个 ID 先经 `::uuid::text`
 * 按数据库 UUID 语义规范化（大小写、花括号等写法都落到同一个规范形式），所有调用路径（请求头、请求体、
 * 停用挂接点）对同一个人取到的都是同一把闸。
 */
const assigneeGate = (tenantId: string, userId: string) =>
  sql`hashtextextended('approval-assignee:' || ${tenantId}::uuid::text || ':' || ${userId}::uuid::text, 0)`;

/**
 * 派单闸（R4-2 / R5-1 / R5-2：成员停用与审批派单的串行协议）。只有审批中心使用它：
 * - 停用方（撤销成员关系、全局停用账号）在接管其在途待办之前以排他方式取闸（可以等），持有到事务结束；
 * - 审批方把某人当作接手人（派单、交接、接管）或以其身份操作时，以共享方式试取，拿不到即视为正在停用，从不等待。
 * 停用方只等闸与业务锁，审批方从不等停用方持有的锁（users 行只被全局停用以 NO KEY UPDATE 锁住，与外键的
 * KEY SHARE 相容；成员行只在撤销的最后一步、接管完成后才锁，同样是 NO KEY UPDATE，F-008 / R6-2），两者不成环。
 * 停用方之间、以及手动交接一批实例时，业务锁按全局取锁顺序取得（handover.LOCK_ORDER，F-008 / R6-3）。
 */
export async function closeAssigneeGate(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${assigneeGate(tenantId, userId)})`);
}

async function enterAssigneeGate(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  const [row] = rowsOf<{ entered: boolean }>(
    await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(${assigneeGate(tenantId, userId)}) AS entered`),
  );
  return Boolean(row?.entered);
}

/** 账号有效（已提交的状态）：本租户成员关系有效、全局账号未停用（DEC-098、R4-3）。用于通知接收人与抄送对象。 */
export async function isActiveAccount(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  const [row] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM tenant_memberships m
      WHERE m.tenant_id=${tenantId} AND m.user_id=${userId}::uuid AND m.status='active'
        AND tenant_account_active(m.user_id)`),
  );
  return Boolean(row);
}

/**
 * 可派：取到派单闸（共享，试取）且账号有效。分两条语句：读状态的快照须晚于取到闸，才能看到停用方释放闸之前
 * 已提交的结果。
 */
export async function isAssignable(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  return (await enterAssigneeGate(tx, tenantId, userId)) && isActiveAccount(tx, tenantId, userId);
}

const ADMIN_PAGE = 50;

interface AdminCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** 可接管的租户管理员候选的一页（DEC-098）：最早开通的在前（确定性）；资格由调用方逐个复核（R4-4）。 */
async function tenantAdminPage(tx: Tx, tenantId: string, excludeUserId?: string, after?: AdminCursor) {
  // 正在停用的成员在同一事务里仍是 active，接管人须排除他本人（DEC-123）。
  const exclude = excludeUserId ? sql`AND a.user_id<>${excludeUserId}::uuid` : sql``;
  const from = after ? sql`AND (a.created_at,a.id)>(${after.createdAt}::timestamptz,${after.id}::uuid)` : sql``;
  return rowsOf<{ id: string; user_id: string; created_at: string }>(
    await tx.execute(sql`SELECT a.id,a.user_id,a.created_at::text AS created_at FROM permission_admins a
      JOIN tenant_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.status='active'
      WHERE a.tenant_id=${tenantId} AND a.role='tenant_admin' AND a.status='active' ${exclude} ${from}
      ORDER BY a.created_at,a.id LIMIT ${ADMIN_PAGE}`),
  );
}

/**
 * 由租户管理员接管异常任务（DEC-098、DEC-123）：按开通先后逐个复核审批资格（已离职 / 不可用的跳过，R4-4；
 * 候选分批扫描不截断，R5-3），
 * 恰为发起人或异动本人的按 DEC-091 回避给其直线经理，回避后仍无人接替的继续找下一个。
 * @returns 接手人；没有任何具备资格的租户管理员时为 null；有但都因本人回避不可用时为最后一个不可用原因
 */
export async function tenantAdminTakeover(
  tx: Tx,
  subject: RoutingSubject,
  facts: Pick<RoutingFacts, 'initiatorUserId' | 'subjectEmployeeId' | 'subjectUserId' | 'chainUserIds'>,
  excludeUserId?: string,
): Promise<ExceptionAdminChoice | null> {
  let blocked: ExceptionAdminChoice | null = null;
  let after: AdminCursor | undefined;
  // R5-3：候选按开通先后分批（每批有上限）扫描，资格过滤后不够就凭游标继续，直到找到或真正用尽。
  for (;;) {
    const page = await tenantAdminPage(tx, subject.tenantId, excludeUserId, after);
    for (const { user_id: userId } of page) {
      if (!(await isEligibleApprover(tx, subject, userId))) continue;
      const admin: Candidate = { userId, personId: await personOfUser(tx, subject.tenantId, userId) };
      const manager = isSelf(admin, facts as RoutingFacts) ? await directManagerOf(tx, subject, admin) : undefined;
      const choice = avoidSelfExceptionAdmin(admin, facts, manager);
      if (choice.kind === 'assign') return choice;
      blocked = choice;
    }
    if (page.length < ADMIN_PAGE) return blocked;
    const last = page.at(-1)!;
    after = { createdAt: last.created_at, id: last.id };
  }
}

export async function personOfUser(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = rowsOf<{ employee_id: string }>(
    await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
      WHERE tenant_id=${tenantId} AND user_id=${userId}::uuid LIMIT 1`),
  );
  return row?.employee_id ?? null;
}

/**
 * F6：离职 / 退休已生效（业务日期上的现行任职是离职或退休）。只用于审批候选资格，不改通用的账号绑定查询
 * （userOfPerson 还要用于识别异动本人等）。
 */
function departed(tx: Tx, subject: EligibilityScope, personId: string): Promise<boolean> {
  return memo(subject, `departed:${personId}`, async () => {
    const record = await findCurrentRecord(tx, subject.tenantId, personId, subject.asOf);
    return record?.kind === 'leave' || record?.kind === 'retirement';
  });
}

/**
 * 审批候选：人员须有有效账号（DEC-098），且离职未生效——找到了审批人但其已离职，同样视为审批人为空，转异常管理员
 * （`14` §11.7，手册 112859839）。
 */
async function candidateOf(tx: Tx, subject: RoutingSubject, personId: string | null): Promise<Candidate> {
  if (!personId) return NOBODY;
  const userId = await userOfPerson(tx, subject.tenantId, personId);
  const usable = userId && (await isAssignable(tx, subject.tenantId, userId));
  return { personId, userId: usable && !(await departed(tx, subject, personId)) ? userId : null };
}

/**
 * 可审批资格（与 candidateOf 同一口径）：账号有效，且绑定的人员离职未生效；没有绑定人员的账号只看成员关系。
 * 所有派出新任务的入口都按它复核——表达式解析、加签激活与回到原审批人（F8），以及普通转交、加签名单、
 * 管理员转交 / 改派、异常管理员交接（第四轮 N2）、停用接管的替代人与回退的租户管理员（R4-4）。
 * 离职前已有的待办不自动撤销，由管理员转交（`14` §11.7）。
 */
export async function isEligibleApprover(tx: Tx, subject: EligibilityScope, userId: string): Promise<boolean> {
  if (!(await isAssignable(tx, subject.tenantId, userId))) return false;
  const personId = await personOfUser(tx, subject.tenantId, userId);
  return !personId || !(await departed(tx, subject, personId));
}

/** 组织在业务日期的现行版本上的负责人 / HRBP（人员 ID）。 */
async function orgRole(tx: Tx, subject: RoutingSubject, orgId: string | null, role: 'head' | 'hrbp') {
  if (!orgId) return null;
  const [row] = rowsOf<{ person_in_charge_id: string | null; hrbp_id: string | null }>(
    await tx.execute(sql`SELECT person_in_charge_id,hrbp_id FROM org_versions
      WHERE tenant_id=${subject.tenantId} AND org_id=${orgId}::uuid AND start_date<=${subject.asOf}::date
      ORDER BY start_date DESC,version_no DESC LIMIT 1`),
  );
  return (role === 'head' ? row?.person_in_charge_id : row?.hrbp_id) ?? null;
}

/** 行政维度祖先链（含自身，自下而上，止于租户根）；深度有界，防环。 */
export async function adminAncestors(tx: Tx, tenantId: string, asOf: string, orgId: string): Promise<string[]> {
  const rows = rowsOf<{ org_id: string }>(
    await tx.execute(sql`WITH RECURSIVE chain(org_id,depth,path) AS (
        SELECT ${orgId}::uuid,0,ARRAY[${orgId}::uuid]
        UNION ALL
        SELECT h.parent_org_id,c.depth+1,c.path||h.parent_org_id FROM chain c
        JOIN LATERAL (SELECT id FROM org_versions v WHERE v.tenant_id=${tenantId} AND v.org_id=c.org_id
          AND v.start_date<=${asOf}::date ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1) cur ON true
        JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=cur.id AND h.dimension='admin'
        WHERE h.parent_org_id IS NOT NULL AND c.depth<100 AND NOT h.parent_org_id=ANY(c.path)
      ) SELECT org_id FROM chain ORDER BY depth`),
  );
  return rows.map((row) => row.org_id);
}

/** 一级组织 = 租户根的直接下级（`14` §2.1 FirstLevelOrganization）。 */
async function firstLevelOrg(tx: Tx, subject: RoutingSubject, orgId: string | null): Promise<string | null> {
  if (!orgId || orgId === subject.tenantId) return null;
  const chain = await adminAncestors(tx, subject.tenantId, subject.asOf, orgId);
  const rootIndex = chain.indexOf(subject.tenantId);
  return rootIndex > 0 ? chain[rootIndex - 1]! : null;
}

export function resolveCandidate(tx: Tx, subject: RoutingSubject, expression: ApproverExpression): Promise<Candidate> {
  return memo(subject, `candidate:${expression}`, () => resolveFresh(tx, subject, expression));
}

async function resolveFresh(tx: Tx, subject: RoutingSubject, expression: ApproverExpression): Promise<Candidate> {
  const { tenantId } = subject;
  switch (expression) {
    case 'owner': {
      // 派单前复核资格（C-非5 / F6）：发起人已停用或已离职时按“审批人为空”处理（DEC-098）。
      if (!(await isEligibleApprover(tx, subject, subject.initiatorUserId))) return NOBODY;
      return { personId: await personOfUser(tx, tenantId, subject.initiatorUserId), userId: subject.initiatorUserId };
    }
    case 'direct_manager':
      // DEC-230：取流程主体而非发起人；findCurrentRecord 只读已生效的主职时间线。
      // TODO(需取证 #95)：原站字段 / 汇报关系及主职 / 兼职来源待核对。
      return directManagerOf(tx, subject, { personId: subject.subjectEmployeeId, userId: null });
    case 'latest_record_department_head':
      return candidateOf(tx, subject, await orgRole(tx, subject, subject.latestDepartmentId, 'head'));
    case 'record_department_head':
      return candidateOf(tx, subject, await orgRole(tx, subject, subject.recordDepartmentId, 'head'));
    case 'record_department_hrbp':
      return candidateOf(tx, subject, await orgRole(tx, subject, subject.recordDepartmentId, 'hrbp'));
    case 'record_first_level_org_head': {
      const firstLevel = await firstLevelOrg(tx, subject, subject.recordDepartmentId);
      return candidateOf(tx, subject, await orgRole(tx, subject, firstLevel, 'head'));
    }
  }
}

/** DEC-230 / DEC-068：直接上级与自审回避共用最新生效主职任职上的直线经理。 */
export function directManagerOf(tx: Tx, subject: RoutingSubject, candidate: Candidate): Promise<Candidate> {
  const key = `manager:${candidate.personId ?? ''}:${candidate.userId ?? ''}`;
  return memo(subject, key, () => managerFresh(tx, subject, candidate));
}

async function managerFresh(tx: Tx, subject: RoutingSubject, candidate: Candidate): Promise<Candidate> {
  const personId =
    candidate.personId ?? (candidate.userId ? await personOfUser(tx, subject.tenantId, candidate.userId) : null);
  if (!personId) return NOBODY;
  const record = await findCurrentRecord(tx, subject.tenantId, personId, subject.asOf);
  return candidateOf(tx, subject, record?.fields.directManagerId ?? null);
}
