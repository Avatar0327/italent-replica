/**
 * 360 人员与组织员工同步（DEC-030）：
 * ① 按员工 ID 挂接，换挂时保留旧员工 ID，并写关联日志；
 * ② 首次同步按邮箱 / 手机 / 工号查重：命中已有人员一律不自动合并，列入冲突清单由系统管理员确认（AC-360-15）；
 *    被忽略的冲突不再重复登记；
 * ③ 同步后邮箱锁定，其余字段 360 端可改，下次同步以组织员工为准覆盖——包括上级（直线经理挂接的人员），
 *    覆盖一律推进 revision、写字段级审计、计入 updated（第 1 轮审查 P2-7）；
 * ④ 导入评价者选择“同步”时，已挂接人员按同一规则刷新（relations.ts，P2-6）。
 * 权限（第 1 轮审查 P2-1 / P2-2）：只读操作人当前员工信息数据范围内的员工；字段按操作人对员工信息
 * （姓名、工号、邮箱、手机）与任职记录（部门、职位、直线经理）的查看权限裁剪——看不到的字段不写入 360，
 * 已有的 360 值保持不变；姓名或邮箱看不到的员工不建人员（FIELD_HIDDEN）。登录邮箱兜底同样要求能看邮箱。
 */
import {
  and,
  eq,
  sql,
  survey360PersonLinkLogs,
  survey360People,
  survey360SyncConflicts,
  type Tx,
  withTenant,
} from '@italent/db';
import { PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  type ModuleScope,
  resolveModuleScopeInTransaction,
  scopeSql,
} from '../permission/module-access.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import {
  actor,
  type Admin,
  audit360,
  type C,
  fail,
  jsonOrEmpty,
  pick,
  type Present,
  read,
  requireRevision,
  rows,
  type Survey360Context,
  BUTTONS,
  uuid,
  type Viewer,
  write,
} from './context.js';
import { findPersonByEmail, loadPerson, type PersonRow, personView, personVisible } from './people.js';

const EMPLOYMENT_RECORD_OBJECT = 'TenantBase.EmploymentRecord';
/** 一次同步最多处理的员工数（有界查询）；超出部分返回游标，按游标续同步。 */
export const SYNC_LIMIT = 5000;

export interface SyncAccess {
  readonly scope: ModuleScope;
  /** 员工信息、任职记录上可查看的字段；undefined = 不限。 */
  readonly personnelFields: ReadonlySet<string> | undefined;
  readonly recordFields: ReadonlySet<string> | undefined;
}

/**
 * 路由层（命令前，含幂等重放）：直接复用 permission/module-route-access.ts 的 objectContext（员工信息 object.view）
 * 与 requestScope（员工信息当前范围），不另写一套（派发规则 §1 自查项，e0a68da）。
 */
export async function routeEmployeeScope(c: C, deps: TenantRouteDeps): Promise<ModuleScope> {
  const ctx = await objectContext(c, deps, PERSONNEL_OBJECT, 'view');
  return requestScope(c, deps, ctx, PERSONNEL_OBJECT);
}

/**
 * 命令事务内重验：同一对象（员工信息）的查看权、数据范围与字段权限（与路由层同一口径：写入口不带页面编码，
 * 列表读取带 .list 页面编码）；没有员工信息查看权 403。
 */
export async function syncAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  tenant: TenantContext,
  pageCode?: string,
): Promise<SyncAccess> {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const canView = await authorize({ ...tenant, action: 'object.view', resource: PERSONNEL_OBJECT, fields: [] });
  if (!canView) fail('FORBIDDEN', '无权查看组织员工信息', 'NO_EMPLOYEE_ACCESS');
  return {
    scope: await resolveModuleScopeInTransaction(deps, tenant, tx, PERSONNEL_OBJECT, pageCode),
    personnelFields: await getModuleViewableFieldsInTransaction(deps, tenant, PERSONNEL_OBJECT, tx),
    recordFields: await getModuleViewableFieldsInTransaction(deps, tenant, EMPLOYMENT_RECORD_OBJECT, tx),
  };
}

export async function employeeInScope(tx: Tx, scope: ModuleScope, employeeId: string): Promise<boolean> {
  const [row] = rows<{ id: string }>(
    await tx.execute(sql`SELECT e.id FROM employment_employees e WHERE e.id = ${employeeId}::uuid
      AND ${scopeSql(scope, { person: sql`e.id` })}`),
  );
  return !!row;
}

/** 组织值；键缺席 = 操作人看不到该字段，不写入 360。 */
type OrgValues = Partial<{
  name: string;
  email: string | null;
  mobile: string | null;
  staffCode: string;
  department: string | null;
  position: string | null;
}>;

interface EmployeeSnapshot {
  readonly employeeId: string;
  readonly values: OrgValues;
  /** 直线经理；undefined = 看不到。 */
  readonly managerId: string | null | undefined;
}

interface EmployeeRow {
  id: string;
  code: string;
  name: string;
  email: string | null;
  work_email: string | null;
  mobile_phone: string | null;
  login_email: string | null;
}

async function snapshotOf(tx: Tx, ctx: Survey360Context, access: SyncAccess, row: EmployeeRow) {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await findCurrentRecord(tx, ctx.tenantId, row.id, asOf);
  if (!record || ['leave', 'retirement'].includes(record.kind)) return null;
  const fields = record.fields as unknown as Record<string, unknown>;
  const may = (set: ReadonlySet<string> | undefined, field: string) => set === undefined || set.has(field);
  const person = (field: string) => may(access.personnelFields, field);
  const recordField = (field: string) => may(access.recordFields, field);
  const values: OrgValues = {};
  if (person('name')) values.name = row.name;
  if (person('code')) values.staffCode = row.code;
  if (person('mobilePhone')) values.mobile = row.mobile_phone;
  if (person('workEmail') || person('email'))
    values.email =
      (person('workEmail') ? row.work_email : null) ??
      (person('email') ? (row.email ?? row.login_email) : null) ??
      null;
  if (recordField('departmentId')) values.department = await orgName(tx, ctx.tenantId, fields.departmentId, asOf);
  if (recordField('positionId')) values.position = await positionName(tx, fields.positionId, asOf);
  const managerId = recordField('directManagerId')
    ? typeof fields.directManagerId === 'string'
      ? fields.directManagerId
      : null
    : undefined;
  return { employeeId: row.id, values, managerId } satisfies EmployeeSnapshot;
}

/** 范围内员工的当前快照（在职、有任职记录），按员工 ID 排序分批。 */
async function employeeSnapshots(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  page: { only?: string; after?: string | undefined; limit?: number | undefined } = {},
) {
  const limit = page.limit ?? SYNC_LIMIT;
  const list = rows<EmployeeRow>(
    await tx.execute(sql`SELECT e.id, e.code, COALESCE(v.name, e.name) AS name, v.email, v.work_email, v.mobile_phone,
        acc.email AS login_email
      FROM employment_employees e
      LEFT JOIN LATERAL (SELECT pv.* FROM personnel_employee_versions pv
        WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
      LEFT JOIN permission_user_person_links l ON l.tenant_id = e.tenant_id AND l.employee_id = e.id
      LEFT JOIN LATERAL tenant_member_accounts(ARRAY[l.user_id]) acc ON l.user_id IS NOT NULL
      WHERE ${scopeSql(access.scope, { person: sql`e.id` })}
        ${page.only ? sql`AND e.id = ${page.only}::uuid` : sql``}
        ${page.after ? sql`AND e.id > ${page.after}::uuid` : sql``}
      ORDER BY e.id LIMIT ${limit + 1}`),
  );
  const batch = list.slice(0, limit);
  const items: EmployeeSnapshot[] = [];
  for (const row of batch) {
    const snapshot = await snapshotOf(tx, ctx, access, row);
    if (snapshot) items.push(snapshot);
  }
  return { items, nextCursor: list.length > limit ? batch.at(-1)!.id : null };
}

async function orgName(tx: Tx, tenantId: string, id: unknown, asOf: string): Promise<string | null> {
  if (typeof id !== 'string') return null;
  const [row] = rows<{ name: string }>(
    await tx.execute(sql`SELECT v.name FROM org_versions v WHERE v.tenant_id = ${tenantId}::uuid
      AND v.org_id = ${id}::uuid AND v.start_date <= ${asOf}::date
      ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
  );
  return row?.name ?? null;
}

async function positionName(tx: Tx, id: unknown, asOf: string): Promise<string | null> {
  if (typeof id !== 'string') return null;
  const [row] = rows<{ name: string }>(
    await tx.execute(sql`SELECT j.name FROM job_position_versions j WHERE j.object_id = ${id}::uuid
      AND j.start_date <= ${asOf}::date ORDER BY j.start_date DESC, j.version_no DESC LIMIT 1`),
  );
  return row?.name ?? null;
}

/** 能否据此新建人员：姓名、邮箱都可见且邮箱非空。 */
function creatable(snapshot: EmployeeSnapshot): 'FIELD_HIDDEN' | 'NO_EMAIL' | null {
  if (snapshot.values.name === undefined || snapshot.values.email === undefined) return 'FIELD_HIDDEN';
  if (!snapshot.values.email) return 'NO_EMAIL';
  return null;
}

async function logLink(
  tx: Tx,
  ctx: Survey360Context,
  person: PersonRow,
  employeeId: string,
  reason: 'new' | 'employee' | 'admin_confirm',
  matchedBy: string[] = [],
) {
  await tx.insert(survey360PersonLinkLogs).values({
    tenantId: ctx.tenantId,
    personId: person.id,
    employeeId,
    previousEmployeeId: person.employeeId && person.employeeId !== employeeId ? person.employeeId : null,
    reason,
    matchedBy,
    actorUserId: ctx.userId,
    commandId: ctx.commandId,
  });
}

async function createSyncedPerson(tx: Tx, ctx: Survey360Context, snapshot: EmployeeSnapshot, matchedBy: string[]) {
  const v = snapshot.values;
  const [row] = await tx
    .insert(survey360People)
    .values({
      tenantId: ctx.tenantId,
      name: v.name!,
      email: v.email!,
      mobile: v.mobile ?? null,
      staffCode: v.staffCode ?? null,
      department: v.department ?? null,
      position: v.position ?? null,
      employeeId: snapshot.employeeId,
      emailLocked: true,
      source: 'org_sync',
      createdBy: ctx.userId,
    })
    .returning();
  await logLink(tx, ctx, row!, snapshot.employeeId, matchedBy.length ? 'admin_confirm' : 'new', matchedBy);
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.sync_create',
    objectType: 'survey360-person',
    objectId: row!.id,
    before: null,
    after: personView(row!),
  });
  return row!;
}

/**
 * 已挂接人员按组织为准覆盖可见字段与上级：有变化才写，推进 revision、写审计（P2-7）；
 * 邮箱为空不覆盖（邮箱是键）；邮箱被其他人员占用时整条不写，返回 EMAIL_TAKEN。
 */
async function refreshLinked(tx: Tx, ctx: Survey360Context, person: PersonRow, snapshot: EmployeeSnapshot) {
  const values: Partial<PersonRow> = Object.fromEntries(
    Object.entries(snapshot.values).filter(([key, value]) => !(key === 'email' && !value)),
  );
  if (snapshot.managerId !== undefined)
    values.superiorPersonId = snapshot.managerId ? ((await linkedPerson(tx, snapshot.managerId))?.id ?? null) : null;
  if (values.superiorPersonId === person.id) values.superiorPersonId = null;
  const changed =
    Object.entries(values).some(([key, value]) => person[key as keyof PersonRow] !== value) || !person.emailLocked;
  if (!changed) return null;
  if (values.email && values.email.toLowerCase() !== person.email.toLowerCase()) {
    const other = await findPersonByEmail(tx, values.email);
    if (other && other.id !== person.id) return 'EMAIL_TAKEN' as const;
  }
  const [saved] = await tx
    .update(survey360People)
    .set({ ...values, emailLocked: true, revision: person.revision + 1, updatedAt: ctx.now })
    .where(and(eq(survey360People.id, person.id), eq(survey360People.revision, person.revision)))
    .returning();
  if (!saved) fail('REVISION_CONFLICT', '人员已被修改，请刷新后重新同步');
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.sync_update',
    objectType: 'survey360-person',
    objectId: person.id,
    before: personView(person),
    after: personView(saved),
  });
  return saved;
}

/** 查重候选：邮箱命中任何人员；手机 / 工号命中尚未挂接的人员（DEC-030 ②）。只用操作人可见的字段查重。 */
async function candidatesOf(tx: Tx, snapshot: EmployeeSnapshot) {
  const found = new Map<string, Set<string>>();
  const add = (id: string, key: string) => found.set(id, (found.get(id) ?? new Set()).add(key));
  const { email, mobile, staffCode } = snapshot.values;
  const unlinked = sql`${survey360People.employeeId} IS NULL`;
  const search = async (key: string, condition: ReturnType<typeof sql>) => {
    for (const row of await tx.select({ id: survey360People.id }).from(survey360People).where(condition))
      add(row.id, key);
  };
  if (email) await search('email', sql`lower(${survey360People.email}) = lower(${email})`);
  if (mobile) await search('mobile', sql`${unlinked} AND ${survey360People.mobile} = ${mobile}`);
  if (staffCode)
    await search('staff_code', sql`${unlinked} AND lower(${survey360People.staffCode}) = lower(${staffCode})`);
  const matchedBy = ['email', 'mobile', 'staff_code'].filter((key) => [...found.values()].some((s) => s.has(key)));
  return { ids: [...found.keys()], matchedBy };
}

export interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  /** 还有未处理的员工时返回游标，下次以 after 续同步。 */
  nextCursor: string | null;
}

async function conflictOf(tx: Tx, employeeId: string, status: 'pending' | 'ignored') {
  const [row] = await tx
    .select({ id: survey360SyncConflicts.id })
    .from(survey360SyncConflicts)
    .where(and(eq(survey360SyncConflicts.employeeId, employeeId), eq(survey360SyncConflicts.status, status)));
  return row;
}

/** 未挂接员工的首次同步：被忽略的跳过；已有待处理冲突复用；查重命中登记冲突；否则新建。 */
async function syncUnlinked(tx: Tx, ctx: Survey360Context, snapshot: EmployeeSnapshot, result: SyncResult) {
  const employeeId = snapshot.employeeId;
  if (await conflictOf(tx, employeeId, 'ignored')) {
    result.skipped.push({ employeeId, reason: 'CONFLICT_IGNORED' });
    return null;
  }
  const pending = await conflictOf(tx, employeeId, 'pending');
  if (pending) {
    result.conflicts.push(pending.id);
    return null;
  }
  const blocked = creatable(snapshot);
  if (blocked) {
    result.skipped.push({ employeeId, reason: blocked });
    return null;
  }
  const candidates = await candidatesOf(tx, snapshot);
  if (candidates.ids.length) {
    const [conflict] = await tx
      .insert(survey360SyncConflicts)
      .values({
        tenantId: ctx.tenantId,
        employeeId,
        candidatePersonIds: candidates.ids,
        matchedBy: candidates.matchedBy,
      })
      .returning();
    await audit360(tx, actor(ctx), {
      action: 'survey360.sync_conflict.create',
      objectType: 'survey360-sync-conflict',
      objectId: conflict!.id,
      before: null,
      after: conflictView(conflict!),
    });
    result.conflicts.push(conflict!.id);
    return null;
  }
  const created = await createSyncedPerson(tx, ctx, snapshot, []);
  result.created.push({ personId: created.id, employeeId });
  return created;
}

export async function syncPeople(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  page: { after?: string | undefined; limit?: number | undefined },
): Promise<SyncResult> {
  const { items, nextCursor } = await employeeSnapshots(tx, ctx, access, page);
  const result: SyncResult = { created: [], updated: [], conflicts: [], skipped: [], nextCursor };
  const linked: { snapshot: EmployeeSnapshot; personId: string; existed: boolean }[] = [];
  for (const snapshot of items) {
    const existing = await linkedPerson(tx, snapshot.employeeId);
    if (existing) linked.push({ snapshot, personId: existing.id, existed: true });
    else {
      const created = await syncUnlinked(tx, ctx, snapshot, result);
      if (created) linked.push({ snapshot, personId: created.id, existed: false });
    }
  }
  // 第二遍：上级可能是本批新建的人员；覆盖与上级一次写入
  for (const { snapshot, personId, existed } of linked) {
    const saved = await refreshLinked(tx, ctx, await loadPerson(tx, personId, true), snapshot);
    if (saved === 'EMAIL_TAKEN') result.skipped.push({ employeeId: snapshot.employeeId, reason: 'EMAIL_TAKEN' });
    else if (saved && existed) result.updated.push({ personId, employeeId: snapshot.employeeId });
  }
  if (nextCursor === null) await backfillSuperiors(tx, ctx, access, new Set(items.map((i) => i.employeeId)), result);
  return result;
}

/**
 * 末页后回补跨页上级（第 3 轮 R2-P2-8）：按游标分页时下属可能在经理之前的页里同步，当时经理还没有 360 人员、上级
 * 留空。最后一页处理完后，回补员工范围内上级仍为空、直线经理已挂接的人员——与同步同一写入（推进 revision、写字段级
 * 审计、计入 updated）。本页刚处理过的人员已按本页结果写入，不重复；有界（SYNC_LIMIT）。
 */
async function backfillSuperiors(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  handled: ReadonlySet<string>,
  result: SyncResult,
) {
  const pending = rows<{ id: string; employee_id: string }>(
    await tx.execute(sql`SELECT p.id, p.employee_id FROM survey360_people p
      WHERE p.employee_id IS NOT NULL AND p.superior_person_id IS NULL
        AND ${scopeSql(access.scope, { person: sql`p.employee_id` })}
      ORDER BY p.employee_id LIMIT ${SYNC_LIMIT}`),
  );
  for (const row of pending) {
    if (handled.has(row.employee_id)) continue;
    const [snapshot] = (await employeeSnapshots(tx, ctx, access, { only: row.employee_id })).items;
    if (!snapshot?.managerId || !(await linkedPerson(tx, snapshot.managerId))) continue;
    const saved = await refreshLinked(tx, ctx, await loadPerson(tx, row.id, true), snapshot);
    if (saved && saved !== 'EMAIL_TAKEN') result.updated.push({ personId: row.id, employeeId: row.employee_id });
  }
}

export async function linkedPerson(tx: Tx, employeeId: string): Promise<PersonRow | undefined> {
  const [row] = await tx.select().from(survey360People).where(eq(survey360People.employeeId, employeeId));
  return row;
}

/**
 * 按组织架构自动添加时取员工对应的 360 人员：先校验员工在操作人当前范围内（已挂接的同样校验，P2-2），
 * 未同步的按同一规则新建（看不到姓名 / 邮箱或有冲突的不建，返回原因）。
 */
export async function personForEmployee(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  employeeId: string,
): Promise<PersonRow | string> {
  const [snapshot] = (await employeeSnapshots(tx, ctx, access, { only: employeeId })).items;
  if (!snapshot) return 'OUT_OF_SCOPE';
  const existing = await linkedPerson(tx, employeeId);
  if (existing) return existing;
  const blocked = creatable(snapshot);
  if (blocked) return blocked;
  if ((await candidatesOf(tx, snapshot)).ids.length) return 'SYNC_CONFLICT';
  return createSyncedPerson(tx, ctx, snapshot, []);
}

/** 导入评价者选择“同步”：已挂接人员按组织刷新（范围外的员工不刷新，P2-6）。 */
export async function refreshFromOrg(tx: Tx, ctx: Survey360Context, access: SyncAccess, person: PersonRow) {
  if (!person.employeeId) return person;
  const [snapshot] = (await employeeSnapshots(tx, ctx, access, { only: person.employeeId })).items;
  if (!snapshot) return person;
  const saved = await refreshLinked(tx, ctx, await loadPerson(tx, person.id, true), snapshot);
  if (saved === 'EMAIL_TAKEN') fail('CONFLICT', '组织员工的邮箱已被其他人员使用', 'EMAIL_TAKEN');
  return saved ?? person;
}

export function conflictView(row: typeof survey360SyncConflicts.$inferSelect) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    candidatePersonIds: row.candidatePersonIds,
    matchedBy: row.matchedBy,
    status: row.status,
    resolution: row.resolution,
    resolvedPersonId: row.resolvedPersonId,
    revision: row.revision,
  };
}

export async function resolveConflict(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  id: string,
  input: { action: 'link' | 'create' | 'ignore'; personId?: string | undefined },
) {
  const [conflict] = await tx
    .select()
    .from(survey360SyncConflicts)
    .where(eq(survey360SyncConflicts.id, id))
    .for('update');
  if (!conflict) fail('NOT_FOUND', '冲突记录不存在');
  const [snapshot] = (await employeeSnapshots(tx, ctx, access, { only: conflict.employeeId })).items;
  // 范围外的员工按不存在处理
  if (!snapshot) fail('NOT_FOUND', '冲突记录不存在');
  if (conflict.status !== 'pending') fail('CONFLICT', '冲突已处理', 'CONFLICT_CLOSED');
  requireRevision(conflict.revision, ctx.expectedRevision);
  let personId: string | null = null;
  if (input.action === 'link') personId = await linkConflict(tx, ctx, conflict, snapshot, input.personId);
  else if (input.action === 'create') {
    const blocked = creatable(snapshot);
    if (blocked) fail('VALIDATION_FAILED', '看不到员工的姓名或邮箱，或员工没有邮箱，不能建 360 人员', blocked);
    if (await findPersonByEmail(tx, snapshot.values.email!)) fail('CONFLICT', '邮箱已被其他人员使用', 'EMAIL_TAKEN');
    personId = (await createSyncedPerson(tx, ctx, snapshot, conflict.matchedBy)).id;
  }
  const [saved] = await tx
    .update(survey360SyncConflicts)
    .set({
      status: input.action === 'ignore' ? 'ignored' : 'resolved',
      resolution: input.action,
      resolvedPersonId: personId,
      resolvedBy: ctx.userId,
      resolvedAt: ctx.now,
      revision: conflict.revision + 1,
    })
    .where(eq(survey360SyncConflicts.id, id))
    .returning();
  await audit360(tx, actor(ctx), {
    action: 'survey360.sync_conflict.resolve',
    objectType: 'survey360-sync-conflict',
    objectId: id,
    before: conflictView(conflict),
    after: conflictView(saved!),
  });
  return conflictView(saved!);
}

async function linkConflict(
  tx: Tx,
  ctx: Survey360Context,
  conflict: typeof survey360SyncConflicts.$inferSelect,
  snapshot: EmployeeSnapshot,
  personId: string | undefined,
): Promise<string> {
  const notCandidate = () => fail('VALIDATION_FAILED', '只能挂接到查重命中的人员', 'NOT_A_CANDIDATE');
  if (!personId || !conflict.candidatePersonIds.includes(personId)) notCandidate();
  if (await linkedPerson(tx, conflict.employeeId)) fail('CONFLICT', '该员工已挂接其他人员', 'EMPLOYEE_LINKED');
  const person = await loadPerson(tx, personId!, true);
  // 精细化权限下看不到的候选不列出，也不可挂接（与不是候选同一结果）
  if (!(await personVisible(tx, ctx.admin, person))) notCandidate();
  await logLink(tx, ctx, person, conflict.employeeId, 'admin_confirm', conflict.matchedBy);
  const [saved] = await tx
    .update(survey360People)
    .set({
      employeeId: conflict.employeeId,
      previousEmployeeId: person.employeeId ?? person.previousEmployeeId,
      emailLocked: true,
      revision: person.revision + 1,
      updatedAt: ctx.now,
    })
    .where(eq(survey360People.id, person.id))
    .returning();
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.link',
    objectType: 'survey360-person',
    objectId: person.id,
    before: personView(person),
    after: personView(saved!),
  });
  const refreshed = await refreshLinked(tx, ctx, saved!, snapshot);
  if (refreshed === 'EMAIL_TAKEN') fail('CONFLICT', '组织员工的邮箱已被其他人员使用', 'EMAIL_TAKEN');
  return person.id;
}

/**
 * 同步相关接口：须持“从系统管理中同步人员信息”按钮（DEC-280①：360 系统 / 高级管理员有，一般管理员没有）。
 * 员工信息查看权与范围在命令前（含幂等重放）与命令事务内各校验一次（第 1 轮审查 P2-4）：失去查看权后用原命令 ID
 * 重放同样 403。
 */
const SYNC = { object: 'person', button: BUTTONS.sync } as const;

export function registerSyncRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people/sync-conflicts', (c) =>
    read(
      c,
      deps,
      SYNC,
      async (tx, admin, tenant) => ({
        items: await pendingConflicts(tx, await syncAccess(tx, deps, tenant, `${PERSONNEL_OBJECT}.list`), admin),
      }),
      conflictList,
    ),
  );
  module.post('/people/sync', (c) => {
    let employees: ModuleScope | undefined;
    return write(
      c,
      deps,
      z.strictObject({ after: uuid.optional(), limit: z.int().min(1).max(SYNC_LIMIT).optional() }),
      async (tx, ctx, input) => syncPeople(tx, ctx, await syncAccess(tx, deps, ctx), input),
      {
        need: SYNC,
        fields: 'none', // 值取自组织员工（按操作人可见字段），after / limit 是协议参数
        revisionFree: true,
        preflight: async () => void (employees = await routeEmployeeScope(c, deps)),
        present: async (viewer, body: SyncResult) => {
          const after = ((await jsonOrEmpty(c)) as { after?: string }).after?.toLowerCase();
          return syncView(viewer, employees!, body, after);
        },
      },
    );
  });
  module.post('/people/sync-conflicts/:id/resolve', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ action: z.enum(['link', 'create', 'ignore']), personId: uuid.optional() }),
      async (tx, ctx, input) => resolveConflict(tx, ctx, await syncAccess(tx, deps, ctx), id, input),
      {
        need: SYNC,
        fields: 'none', // 处理选择（挂接 / 新建 / 忽略），人员值取自组织员工
        // 命令前（含命中台账的重放）按当前员工范围复核冲突员工：撤回范围后原键重放 404（第 3 轮 R2-P2-1）
        preflight: async () => {
          const scope = await routeEmployeeScope(c, deps);
          await withTenant(deps.db, tenantOf(c).tenantId, (tx) => requireConflictInScope(tx, scope, id));
        },
        present: conflictPresent,
      },
    );
  });
}

async function requireConflictInScope(tx: Tx, scope: ModuleScope, id: string): Promise<void> {
  const [conflict] = await tx
    .select({ employeeId: survey360SyncConflicts.employeeId })
    .from(survey360SyncConflicts)
    .where(eq(survey360SyncConflicts.id, id));
  if (!conflict || !(await employeeInScope(tx, scope, conflict.employeeId))) fail('NOT_FOUND', '冲突记录不存在');
}

/** 冲突清单：嵌套候选按查看人的人员字段裁剪（候选的 personId 对应人员 id）；冲突本身是协议字段。 */
const conflictList: Present = async (viewer, body: { items: { candidates: object[] }[] }) => {
  const fields = await viewer.fields('person');
  return {
    items: body.items.map((item) => ({
      ...item,
      candidates: item.candidates.map((candidate) => pick(candidate, fields, { personId: 'id' })),
    })),
  };
};

/** 冲突处理回执：冲突协议字段；精细化权限下看不到的候选 / 处理结果人员 ID 去掉。 */
const conflictPresent: Present = async (viewer, body: ReturnType<typeof conflictView>) => {
  const visible = async (id: string) => personVisible(viewer.tx, viewer.admin, await loadPerson(viewer.tx, id));
  const candidates = [];
  for (const id of body.candidatePersonIds) if (await visible(id)) candidates.push(id);
  const resolved = body.resolvedPersonId && (await visible(body.resolvedPersonId)) ? body.resolvedPersonId : null;
  return { ...body, candidatePersonIds: candidates, resolvedPersonId: resolved };
};

/**
 * 同步回执：返回前（新请求与重放同一路径）按当前员工范围复核（第 3 轮 R2-P2-1），范围外员工的新建 / 更新 / 冲突 /
 * 跳过条目去掉；人员条目另按精细化范围与人员字段裁剪。游标员工不在范围内时退回到回执里最后一个范围内员工（或请求的
 * after），不带出范围外员工 ID。
 */
async function syncView(viewer: Viewer, employees: ModuleScope, body: SyncResult, after: string | undefined) {
  const { tx, admin } = viewer;
  const inScope = (employeeId: string) => employeeInScope(tx, employees, employeeId);
  const fields = await viewer.fields('person');
  const people = async (list: SyncResult['created']) => {
    const kept = [];
    for (const entry of list)
      if ((await inScope(entry.employeeId)) && (await personVisible(tx, admin, await loadPerson(tx, entry.personId))))
        kept.push(pick(entry, fields, { personId: 'id' }));
    return kept;
  };
  const conflicts = [];
  for (const id of body.conflicts) {
    const [row] = await tx
      .select({ employeeId: survey360SyncConflicts.employeeId })
      .from(survey360SyncConflicts)
      .where(eq(survey360SyncConflicts.id, id));
    if (row && (await inScope(row.employeeId))) conflicts.push({ id, employeeId: row.employeeId });
  }
  const skipped = [];
  for (const entry of body.skipped) if (await inScope(entry.employeeId)) skipped.push(entry);
  const seen = [...body.created, ...body.updated, ...skipped, ...conflicts].map((e) => e.employeeId);
  let nextCursor = body.nextCursor;
  if (nextCursor && !(await inScope(nextCursor))) {
    const kept: string[] = [];
    for (const id of seen) if (await inScope(id)) kept.push(id);
    nextCursor = kept.sort().at(-1) ?? after ?? null;
  }
  return {
    created: await people(body.created),
    updated: await people(body.updated),
    conflicts: conflicts.map((c) => c.id),
    skipped,
    nextCursor,
  };
}

async function pendingConflicts(tx: Tx, access: SyncAccess, admin: Admin) {
  const list = rows<{
    id: string;
    employee_id: string;
    employee_name: string;
    matched_by: string[];
    candidate_person_ids: string[];
    status: string;
    revision: number;
  }>(
    await tx.execute(sql`SELECT k.*, e.name AS employee_name FROM survey360_sync_conflicts k
      JOIN employment_employees e ON e.tenant_id = k.tenant_id AND e.id = k.employee_id
      WHERE k.status = 'pending' AND ${scopeSql(access.scope, { person: sql`k.employee_id` })}
      ORDER BY k.created_at, k.id LIMIT 500`),
  );
  const nameVisible = access.personnelFields === undefined || access.personnelFields.has('name');
  const items = [];
  for (const row of list) {
    const candidates = [];
    for (const personId of row.candidate_person_ids) {
      const person = await loadPerson(tx, personId);
      // 精细化权限下只列可见候选（DEC-289①）
      if (!(await personVisible(tx, admin, person))) continue;
      candidates.push({ personId, name: person.name, email: person.email, employeeId: person.employeeId });
    }
    items.push({
      id: row.id,
      employeeId: row.employee_id,
      // 员工姓名同样按员工信息的字段权限裁剪
      ...(nameVisible ? { employeeName: row.employee_name } : {}),
      matchedBy: row.matched_by,
      candidates,
      status: row.status,
      revision: row.revision,
    });
  }
  return items;
}
