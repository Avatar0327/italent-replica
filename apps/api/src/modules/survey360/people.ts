/**
 * 360 人员表（DEC-027）与组织员工同步（DEC-030）：
 * ① 按员工 ID 挂接，换挂时保留旧员工 ID，并写关联日志；
 * ② 首次同步按邮箱 / 手机 / 工号查重：命中已有人员一律不自动合并，列入冲突清单由系统管理员确认（AC-360-15）；
 * ③ 同步后邮箱锁定（360 端不可改，AC-360-14），其余字段 360 端可改，下次同步以组织员工为准覆盖；
 * ④ 批量导入评价者可选“不同步”（relations.ts）。
 * 同步读取的员工按操作人当前的员工信息数据范围与字段权限裁剪：范围外的员工不同步、无权查看的字段不复制。
 */
import { and, eq, sql, survey360PersonLinkLogs, survey360People, survey360SyncConflicts, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { pageQuery, uuidParam } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  type ModuleScope,
  resolveModuleScopeInTransaction,
  scopeSql,
} from '../permission/module-access.js';
import {
  actor,
  audit360,
  email,
  fail,
  optionalText,
  read,
  requireNewObject,
  requireRevision,
  rows,
  type Survey360Context,
  type Writer,
  SYSTEM_ONLY,
  text,
  uuid,
  write,
} from './context.js';

export type PersonRow = typeof survey360People.$inferSelect;

export function personView(row: PersonRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    staffCode: row.staffCode,
    department: row.department,
    position: row.position,
    superiorPersonId: row.superiorPersonId,
    employeeId: row.employeeId,
    previousEmployeeId: row.previousEmployeeId,
    emailLocked: row.emailLocked,
    source: row.source,
    revision: row.revision,
  };
}

export const personInput = z.strictObject({
  name: text(100),
  email,
  mobile: optionalText(50),
  staffCode: optionalText(100),
  department: optionalText(200),
  position: optionalText(200),
  superiorPersonId: uuid.nullable().optional(),
});
export type PersonInput = z.infer<typeof personInput>;

export async function loadPerson(tx: Tx, id: string, lock = false): Promise<PersonRow> {
  const query = tx.select().from(survey360People).where(eq(survey360People.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) fail('NOT_FOUND', '人员不存在');
  return row;
}

export async function findPersonByEmail(tx: Tx, value: string): Promise<PersonRow | undefined> {
  const [row] = await tx
    .select()
    .from(survey360People)
    .where(sql`lower(${survey360People.email}) = lower(${value})`);
  return row;
}

async function requireSuperior(tx: Tx, id: string | null | undefined, self?: string) {
  if (!id) return;
  if (id === self) fail('VALIDATION_FAILED', '上级不能是本人', 'SUPERIOR_SELF');
  await loadPerson(tx, id).catch(() => fail('VALIDATION_FAILED', '上级人员不存在', 'SUPERIOR_NOT_FOUND'));
}

/** 手工 / 导入新建人员（外部或未同步的人员）。邮箱重复由唯一索引拒绝（409）。 */
export async function createPerson(
  tx: Tx,
  ctx: Writer,
  input: PersonInput,
  source: 'manual' | 'import' = 'manual',
): Promise<PersonRow> {
  await requireSuperior(tx, input.superiorPersonId);
  if (await findPersonByEmail(tx, input.email)) fail('CONFLICT', '邮箱已被其他人员使用', 'EMAIL_TAKEN');
  const [row] = await tx
    .insert(survey360People)
    .values({
      tenantId: ctx.tenantId,
      name: input.name,
      email: input.email,
      mobile: input.mobile ?? null,
      staffCode: input.staffCode ?? null,
      department: input.department ?? null,
      position: input.position ?? null,
      superiorPersonId: input.superiorPersonId ?? null,
      source,
      createdBy: ctx.userId,
    })
    .returning();
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.create',
    objectType: 'survey360-person',
    objectId: row!.id,
    before: null,
    after: personView(row!),
  });
  return row!;
}

/** 编辑人员：已同步人员的邮箱锁定（DEC-030 ③）。 */
export async function updatePerson(
  tx: Tx,
  ctx: Survey360Context,
  current: PersonRow,
  patch: Partial<PersonInput>,
  action = 'survey360.person.update',
): Promise<PersonRow> {
  if (patch.email !== undefined && patch.email !== current.email && current.emailLocked)
    fail('CONFLICT', '已同步人员的邮箱以组织员工为准，不可在 360 端修改', 'EMAIL_LOCKED');
  if (patch.email !== undefined && patch.email.toLowerCase() !== current.email.toLowerCase()) {
    const other = await findPersonByEmail(tx, patch.email);
    if (other && other.id !== current.id) fail('CONFLICT', '邮箱已被其他人员使用', 'EMAIL_TAKEN');
  }
  await requireSuperior(tx, patch.superiorPersonId, current.id);
  const values = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const [saved] = await tx
    .update(survey360People)
    .set({ ...values, revision: current.revision + 1, updatedAt: ctx.now })
    .where(and(eq(survey360People.id, current.id), eq(survey360People.revision, current.revision)))
    .returning();
  if (!saved) fail('REVISION_CONFLICT', '人员已被修改，请刷新后显式重提');
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-person',
    objectId: current.id,
    before: personView(current),
    after: personView(saved),
  });
  return saved;
}

// ---------- 组织员工同步 ----------

/** 一次同步最多处理的员工数（有界查询）；超出的部分在结果里标 truncated，下次再同步。 */
const SYNC_LIMIT = 5000;

interface EmployeeSnapshot {
  readonly employeeId: string;
  readonly name: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly staffCode: string;
  readonly department: string | null;
  readonly position: string | null;
  readonly managerId: string | null;
}

interface SyncAccess {
  readonly scope: ModuleScope;
  /** 员工信息上可查看的字段；undefined = 不限。 */
  readonly fields: ReadonlySet<string> | undefined;
}

async function syncAccess(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext): Promise<SyncAccess> {
  const canView = await authorizeInTransaction(
    deps.authorize,
    tx,
  )({
    ...tenant,
    action: 'object.view',
    resource: PERSONNEL_OBJECT,
    fields: [],
  });
  if (!canView) fail('FORBIDDEN', '无权查看组织员工信息，不能同步', 'NO_EMPLOYEE_ACCESS');
  return {
    scope: await resolveModuleScopeInTransaction(deps, tenant, tx, PERSONNEL_OBJECT, `${PERSONNEL_OBJECT}.list`),
    fields: await getModuleViewableFieldsInTransaction(deps, tenant, PERSONNEL_OBJECT, tx),
  };
}

/** 范围内员工的当前信息快照（在职、有任职记录的员工）；只复制操作人可查看的字段。 */
async function employeeSnapshots(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  only?: string,
): Promise<{ items: EmployeeSnapshot[]; truncated: boolean }> {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const may = (field: string) => access.fields === undefined || access.fields.has(field);
  const list = rows<{
    id: string;
    code: string;
    name: string;
    email: string | null;
    work_email: string | null;
    mobile_phone: string | null;
    login_email: string | null;
  }>(
    await tx.execute(sql`SELECT e.id, e.code, COALESCE(v.name, e.name) AS name, v.email, v.work_email, v.mobile_phone,
        acc.email AS login_email
      FROM employment_employees e
      LEFT JOIN LATERAL (SELECT pv.* FROM personnel_employee_versions pv
        WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
      LEFT JOIN permission_user_person_links l ON l.tenant_id = e.tenant_id AND l.employee_id = e.id
      LEFT JOIN LATERAL tenant_member_accounts(ARRAY[l.user_id]) acc ON l.user_id IS NOT NULL
      WHERE ${scopeSql(access.scope, { person: sql`e.id` })}
        ${only ? sql`AND e.id = ${only}::uuid` : sql``}
      ORDER BY e.created_at, e.id LIMIT ${SYNC_LIMIT + 1}`),
  );
  const items: EmployeeSnapshot[] = [];
  for (const row of list.slice(0, SYNC_LIMIT)) {
    const record = await findCurrentRecord(tx, ctx.tenantId, row.id, asOf);
    if (!record || ['leave', 'retirement'].includes(record.kind)) continue;
    const fields = record.fields as unknown as Record<string, unknown>;
    const mail =
      (may('workEmail') ? row.work_email : null) ?? (may('email') ? row.email : null) ?? row.login_email ?? null;
    items.push({
      employeeId: row.id,
      name: row.name,
      email: mail,
      mobile: may('mobilePhone') ? row.mobile_phone : null,
      staffCode: row.code,
      department: await orgName(tx, ctx.tenantId, fields.departmentId, asOf),
      position: await positionName(tx, fields.positionId, asOf),
      managerId: typeof fields.directManagerId === 'string' ? fields.directManagerId : null,
    });
  }
  return { items, truncated: list.length > SYNC_LIMIT };
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

function orgValues(snapshot: EmployeeSnapshot) {
  return {
    name: snapshot.name,
    email: snapshot.email!,
    mobile: snapshot.mobile,
    staffCode: snapshot.staffCode,
    department: snapshot.department,
    position: snapshot.position,
  };
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
  const [row] = await tx
    .insert(survey360People)
    .values({
      tenantId: ctx.tenantId,
      ...orgValues(snapshot),
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

/** 已挂接人员：组织员工为准覆盖（含邮箱），邮箱保持锁定。 */
async function refreshLinked(tx: Tx, ctx: Survey360Context, person: PersonRow, snapshot: EmployeeSnapshot) {
  const values = orgValues(snapshot);
  const changed = Object.entries(values).some(([k, v]) => person[k as keyof PersonRow] !== v) || !person.emailLocked;
  if (!changed) return null;
  if (values.email.toLowerCase() !== person.email.toLowerCase()) {
    const other = await findPersonByEmail(tx, values.email);
    if (other && other.id !== person.id) return 'EMAIL_TAKEN' as const;
  }
  const [saved] = await tx
    .update(survey360People)
    .set({ ...values, emailLocked: true, revision: person.revision + 1, updatedAt: ctx.now })
    .where(eq(survey360People.id, person.id))
    .returning();
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.sync_update',
    objectType: 'survey360-person',
    objectId: person.id,
    before: personView(person),
    after: personView(saved!),
  });
  return saved!;
}

/** 查重候选：邮箱命中任何人员；手机 / 工号命中尚未挂接的人员（DEC-030 ②）。 */
async function candidatesOf(tx: Tx, snapshot: EmployeeSnapshot) {
  const found = new Map<string, Set<string>>();
  const add = (id: string, key: string) => found.set(id, (found.get(id) ?? new Set()).add(key));
  for (const row of await tx
    .select({ id: survey360People.id })
    .from(survey360People)
    .where(sql`lower(${survey360People.email}) = lower(${snapshot.email})`))
    add(row.id, 'email');
  const unlinked = sql`${survey360People.employeeId} IS NULL`;
  if (snapshot.mobile)
    for (const row of await tx
      .select({ id: survey360People.id })
      .from(survey360People)
      .where(and(unlinked, eq(survey360People.mobile, snapshot.mobile))))
      add(row.id, 'mobile');
  for (const row of await tx
    .select({ id: survey360People.id })
    .from(survey360People)
    .where(and(unlinked, sql`lower(${survey360People.staffCode}) = lower(${snapshot.staffCode})`)))
    add(row.id, 'staff_code');
  const matchedBy = ['email', 'mobile', 'staff_code'].filter((key) => [...found.values()].some((s) => s.has(key)));
  return { ids: [...found.keys()], matchedBy };
}

export interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  truncated: boolean;
}

async function syncPeople(tx: Tx, ctx: Survey360Context, access: SyncAccess): Promise<SyncResult> {
  const { items, truncated } = await employeeSnapshots(tx, ctx, access);
  const result: SyncResult = { created: [], updated: [], conflicts: [], skipped: [], truncated };
  const linkedIds = new Map<string, string>();
  for (const snapshot of items) {
    if (!snapshot.email) {
      result.skipped.push({ employeeId: snapshot.employeeId, reason: 'NO_EMAIL' });
      continue;
    }
    const [linked] = await tx
      .select()
      .from(survey360People)
      .where(eq(survey360People.employeeId, snapshot.employeeId))
      .for('update');
    if (linked) {
      linkedIds.set(snapshot.employeeId, linked.id);
      const saved = await refreshLinked(tx, ctx, linked, snapshot);
      if (saved === 'EMAIL_TAKEN') result.skipped.push({ employeeId: snapshot.employeeId, reason: 'EMAIL_TAKEN' });
      else if (saved) result.updated.push({ personId: linked.id, employeeId: snapshot.employeeId });
      continue;
    }
    const [pending] = await tx
      .select({ id: survey360SyncConflicts.id })
      .from(survey360SyncConflicts)
      .where(
        and(eq(survey360SyncConflicts.employeeId, snapshot.employeeId), eq(survey360SyncConflicts.status, 'pending')),
      );
    if (pending) {
      result.conflicts.push(pending.id);
      continue;
    }
    const candidates = await candidatesOf(tx, snapshot);
    if (candidates.ids.length) {
      const [conflict] = await tx
        .insert(survey360SyncConflicts)
        .values({
          tenantId: ctx.tenantId,
          employeeId: snapshot.employeeId,
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
      continue;
    }
    const created = await createSyncedPerson(tx, ctx, snapshot, []);
    linkedIds.set(snapshot.employeeId, created.id);
    result.created.push({ personId: created.id, employeeId: snapshot.employeeId });
  }
  // 上级 = 直线经理挂接的 360 人员（组织为准）
  for (const snapshot of items) {
    const personId = linkedIds.get(snapshot.employeeId);
    if (!personId) continue;
    const superior = snapshot.managerId ? ((await linkedPerson(tx, snapshot.managerId))?.id ?? null) : null;
    await tx
      .update(survey360People)
      .set({ superiorPersonId: superior })
      .where(
        and(eq(survey360People.id, personId), sql`${survey360People.superiorPersonId} IS DISTINCT FROM ${superior}`),
      );
  }
  return result;
}

export async function linkedPerson(tx: Tx, employeeId: string): Promise<PersonRow | undefined> {
  const [row] = await tx.select().from(survey360People).where(eq(survey360People.employeeId, employeeId));
  return row;
}

/** 按组织架构自动添加评价者时，为尚未同步的员工建 360 人员（同一查重规则：有冲突的不建，返回原因）。 */
export async function personForEmployee(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  employeeId: string,
): Promise<PersonRow | string> {
  const existing = await linkedPerson(tx, employeeId);
  if (existing) return existing;
  const [snapshot] = (await employeeSnapshots(tx, ctx, access, employeeId)).items;
  if (!snapshot) return 'OUT_OF_SCOPE';
  if (!snapshot.email) return 'NO_EMAIL';
  if ((await candidatesOf(tx, snapshot)).ids.length) return 'SYNC_CONFLICT';
  return createSyncedPerson(tx, ctx, snapshot, []);
}

export { syncAccess, type SyncAccess };

function conflictView(row: typeof survey360SyncConflicts.$inferSelect) {
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

async function resolveConflict(
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
  const [snapshot] = (await employeeSnapshots(tx, ctx, access, conflict.employeeId)).items;
  // 范围外的员工按不存在处理
  if (!snapshot) fail('NOT_FOUND', '冲突记录不存在');
  if (conflict.status !== 'pending') fail('CONFLICT', '冲突已处理', 'CONFLICT_CLOSED');
  requireRevision(conflict.revision, ctx.expectedRevision);
  let personId: string | null = null;
  if (input.action === 'link') {
    if (!input.personId || !conflict.candidatePersonIds.includes(input.personId))
      fail('VALIDATION_FAILED', '只能挂接到查重命中的人员', 'NOT_A_CANDIDATE');
    if (await linkedPerson(tx, conflict.employeeId)) fail('CONFLICT', '该员工已挂接其他人员', 'EMPLOYEE_LINKED');
    const person = await loadPerson(tx, input.personId, true);
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
    const refreshed = snapshot.email ? await refreshLinked(tx, ctx, saved!, snapshot) : null;
    if (refreshed === 'EMAIL_TAKEN') fail('CONFLICT', '组织员工的邮箱已被其他人员使用', 'EMAIL_TAKEN');
    personId = person.id;
  } else if (input.action === 'create') {
    if (!snapshot.email) fail('VALIDATION_FAILED', '员工没有邮箱，不能建 360 人员', 'NO_EMAIL');
    if (await findPersonByEmail(tx, snapshot.email)) fail('CONFLICT', '邮箱已被其他人员使用', 'EMAIL_TAKEN');
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

export function registerPeopleRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerPeopleLists(module, deps);
  registerPersonReads(module, deps);
  registerPeopleWrites(module, deps);
}

function registerPeopleLists(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people', (c) =>
    read(c, deps, async (tx) => {
      const page = pageQuery(c);
      const q = c.req.query('q')?.trim();
      const filter = q
        ? sql`(${survey360People.name} ILIKE ${`%${q}%`} OR ${survey360People.email} ILIKE ${`%${q}%`})`
        : sql`true`;
      const items = await tx
        .select()
        .from(survey360People)
        .where(filter)
        .orderBy(survey360People.createdAt, survey360People.id)
        .limit(page.limit)
        .offset(page.offset);
      return { items: items.map(personView), page: page.page, pageSize: page.pageSize };
    }),
  );
  module.get('/people/sync-conflicts', (c) =>
    read(
      c,
      deps,
      async (tx, _admin, tenant) => {
        const access = await syncAccess(tx, deps, tenant);
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
        const items = [];
        for (const row of list) {
          const candidates = [];
          for (const personId of row.candidate_person_ids) {
            const person = await loadPerson(tx, personId);
            candidates.push({ personId, name: person.name, email: person.email, employeeId: person.employeeId });
          }
          items.push({
            id: row.id,
            employeeId: row.employee_id,
            employeeName: row.employee_name,
            matchedBy: row.matched_by,
            candidates,
            status: row.status,
            revision: row.revision,
          });
        }
        return { items };
      },
      SYSTEM_ONLY,
    ),
  );
}

function registerPersonReads(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people/:id', (c) => read(c, deps, async (tx) => personView(await loadPerson(tx, uuidParam(c)))));
  module.get('/people/:id/link-logs', (c) =>
    read(
      c,
      deps,
      async (tx) => {
        const person = await loadPerson(tx, uuidParam(c));
        const items = await tx
          .select()
          .from(survey360PersonLinkLogs)
          .where(eq(survey360PersonLinkLogs.personId, person.id))
          .orderBy(survey360PersonLinkLogs.occurredAt);
        return {
          items: items.map((l) => ({
            id: l.id,
            employeeId: l.employeeId,
            previousEmployeeId: l.previousEmployeeId,
            reason: l.reason,
            matchedBy: l.matchedBy,
            actorUserId: l.actorUserId,
            occurredAt: l.occurredAt.toISOString(),
          })),
        };
      },
      SYSTEM_ONLY,
    ),
  );
}

function registerPeopleWrites(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/people', (c) =>
    write(
      c,
      deps,
      personInput,
      async (tx, ctx, input) => {
        requireNewObject(ctx);
        return personView(await createPerson(tx, ctx, input));
      },
      { status: 201 },
    ),
  );
  module.put('/people/:id', (c) => {
    const id = uuidParam(c);
    return write(c, deps, personInput.partial(), async (tx, ctx, input) => {
      const current = await loadPerson(tx, id, true);
      requireRevision(current.revision, ctx.expectedRevision);
      return personView(await updatePerson(tx, ctx, current, input));
    });
  });
  module.post('/people/sync', (c) =>
    write(c, deps, z.strictObject({}), async (tx, ctx) => syncPeople(tx, ctx, await syncAccess(tx, deps, ctx)), {
      roles: SYSTEM_ONLY,
      revisionFree: true,
    }),
  );
  module.post('/people/sync-conflicts/:id/resolve', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.strictObject({ action: z.enum(['link', 'create', 'ignore']), personId: uuid.optional() }),
      async (tx, ctx, input) => resolveConflict(tx, ctx, await syncAccess(tx, deps, ctx), id, input),
      { roles: SYSTEM_ONLY },
    );
  });
}
