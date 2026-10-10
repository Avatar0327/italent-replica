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
 * 精细化权限生效时（受限管理员，admin.people 非空；第 6 轮 R5-P2-1）：结果不能随其看不到的人员变化——查重、冲突与
 * 邮箱占用都可能来自看不到的人员，故受限管理员不新建人员（未挂接的员工一律跳过 PERSON_NOT_AVAILABLE，不查重、
 * 不登记冲突）、刷新已挂接人员时不改邮箱（邮箱是键，以不受限管理员的同步为准，不会出现 EMAIL_TAKEN），冲突清单
 * 与冲突处理 403；回执里的冲突与跳过原因按查看人当时的身份同样处理（重放同一路径）。
 */
import {
  and,
  eq,
  inArray,
  sql,
  survey360PersonLinkLogs,
  survey360People,
  survey360SyncConflicts,
  type Tx,
  withTenant,
} from '@italent/db';
import { PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { personAvatars } from '../avatar/references.js';
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
import {
  findPersonByEmail,
  loadPerson,
  personFilter,
  type PersonRow,
  personView,
  personVisible,
  requireUnrestricted,
  visiblePersonIds,
} from './people.js';

const EMPLOYMENT_RECORD_OBJECT = 'TenantBase.EmploymentRecord';
/** 一次同步最多处理的员工数（有界查询）；超出部分返回游标，按游标续同步。 */
export const SYNC_LIMIT = 5000;

/** 写入前按当前权限复核发现目标已不在管理范围内（见 refreshLinked）。 */
const OUT_OF_SCOPE = 'OUT_OF_SCOPE' as const;

/**
 * 测试探针（F-043 真 PG 交错用，生产为空）：beforeLock 在目标已列出、锁计划尚未取锁时调用（测试在这里让组织侧把
 * 员工调出范围）；beforeWrite 在目标已加锁、要写、尚未重取当前权限时调用（测试在这里撤空管理范围或发起调动）。
 */
export const syncProbe: {
  beforeLock?: () => Promise<void>;
  beforeWrite?: (employeeId: string) => Promise<void>;
} = {};
/** 精细化下受限管理员不可添加 / 不新建人员的统一原因（与 requireCreatable 同一代码，R2-P2-7、R5-P2-1）。 */
const NOT_AVAILABLE = 'PERSON_NOT_AVAILABLE';

export interface SyncAccess {
  readonly scope: ModuleScope;
  /** 员工信息、任职记录上可查看的字段；undefined = 不限。 */
  readonly personnelFields: ReadonlySet<string> | undefined;
  readonly recordFields: ReadonlySet<string> | undefined;
  /** 重新取得员工信息的查看权、数据范围与字段（写入目标加锁后用，F-043 第 3 轮）。 */
  readonly refresh: () => Promise<SyncAccess>;
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
 * 事务内取员工信息的查看权与数据范围（与路由层同一口径：写入口不带页面编码，列表读取带 .list 页面编码）；没有
 * 查看权返回 null。同步、冲突清单与同步冲突的审计查看（第 4 轮 R3-P2-2）共用这一判定。
 */
export async function employeeScope(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  tenant: TenantContext,
  pageCode?: string,
): Promise<ModuleScope | null> {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const canView = await authorize({ ...tenant, action: 'object.view', resource: PERSONNEL_OBJECT, fields: [] });
  return canView ? resolveModuleScopeInTransaction(deps, tenant, tx, PERSONNEL_OBJECT, pageCode) : null;
}

/** 命令事务内重验：员工信息的查看权、数据范围与字段权限；没有员工信息查看权 403。 */
export async function syncAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  tenant: TenantContext,
  pageCode?: string,
): Promise<SyncAccess> {
  const scope = await employeeScope(tx, deps, tenant, pageCode);
  if (!scope) fail('FORBIDDEN', '无权查看组织员工信息', 'NO_EMPLOYEE_ACCESS');
  return {
    scope,
    personnelFields: await getModuleViewableFieldsInTransaction(deps, tenant, PERSONNEL_OBJECT, tx),
    recordFields: await getModuleViewableFieldsInTransaction(deps, tenant, EMPLOYMENT_RECORD_OBJECT, tx),
    refresh: () => syncAccess(tx, deps, tenant, pageCode),
  };
}

const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** 本事务已取的锁计划（员工 ID）；一个事务只取一次。 */
const plans = new WeakMap<Tx, ReadonlySet<string>>();

/**
 * 锁计划（F-043 第 3 轮 P2-2）：一条命令要写的员工在处理任何目标之前一次取齐——员工行按员工 ID 升序 FOR SHARE（与
 * 调动 / 任职写入同一全局顺序：transfer-locks.ts 按 UUID 升序锁员工），再按人员 ID 升序锁这些员工已挂接的 360 人员
 * 及载荷里点名的已有人员（FOR NO KEY UPDATE）。之后新建、更新、回补、导入、自动添加只写计划内的员工，不再中途取
 * 员工锁，不会锁住后面的员工再回头等前面的员工；组织侧的调动要么在取锁前已提交（随后按当前状态重读），要么等本命令
 * 结束。再取一次会打乱锁顺序，按程序错误处理。
 */
export async function lockPlan(
  tx: Tx,
  tenantId: string,
  employees: readonly string[],
  persons: readonly string[] = [],
): Promise<void> {
  if (plans.has(tx)) throw new Error('同一事务只能取一次 360 同步锁计划');
  const ids = [...new Set(employees.map((id) => id.toLowerCase()))];
  plans.set(tx, new Set(ids));
  await syncProbe.beforeLock?.();
  if (ids.length)
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${uuids(ids)}) ORDER BY id FOR SHARE`);
  const people = [...new Set(persons)];
  if (ids.length || people.length)
    await tx.execute(sql`SELECT id FROM survey360_people
      WHERE employee_id = ANY(${uuids(ids)}) OR id = ANY(${uuids(people)}) ORDER BY id FOR NO KEY UPDATE`);
}

/**
 * 写入目标须在锁计划内：列出目标到取锁之间人员被改挂到计划外的员工（如冲突处理挂接）时返回 409，由调用方刷新后
 * 显式重提，不在中途补锁（与 transfer-locks.ts 的 TRANSFER_LOCK_PLAN_CHANGED 同一做法）。
 */
function requirePlanned(tx: Tx, employeeId: string): void {
  if (!plans.get(tx)?.has(employeeId)) fail('CONFLICT', '同步涉及的人员已变化，请刷新后重试', 'SYNC_LOCK_PLAN_CHANGED');
}

const GRANTED: unique symbol = Symbol('survey360.syncWriteGrant');

/**
 * 写入许可（F-043 第 4 轮，统一入口）：本文件里写 360 人员（新建、覆盖、挂接）与写同步冲突（登记、处理）的函数只接受
 * 许可，不接受命令开始时的 ctx / access。许可只能由 authorizeTarget 产生，所以任何写入之前必然经过：目标员工在锁计划
 * 内（已按全局顺序锁住）→ 重新取得操作人的当前权限（ctx.reauthorize：功能权限、资源守卫、360 人员范围；
 * access.refresh：员工信息查看权、范围、字段）→ 按当前范围读到该员工的快照。验权与“有没有字段变化”无关。
 */
export interface WriteGrant {
  readonly [GRANTED]: true;
  /** 带当前操作人（admin）的命令上下文。 */
  readonly ctx: Survey360Context;
  readonly access: SyncAccess;
  /** 按当前权限读到的目标员工快照。 */
  readonly snapshot: EmployeeSnapshot;
}

/**
 * 取得写入许可（F-043 第 3、4 轮 P2-1）：失去功能权限时 reauthorize 抛错、整条命令回滚；员工已不在当前范围内（调出、
 * 范围收窄、离职）返回 null，调用方按各自口径跳过或按不存在处理。
 */
async function authorizeTarget(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  employeeId: string,
): Promise<WriteGrant | null> {
  requirePlanned(tx, employeeId);
  await syncProbe.beforeWrite?.(employeeId);
  const current: Survey360Context = { ...ctx, admin: await ctx.reauthorize() };
  const fresh = await access.refresh();
  const snapshot = await snapshotIn(tx, current, fresh, employeeId);
  return snapshot ? { [GRANTED]: true, ctx: current, access: fresh, snapshot } : null;
}

/** 一批员工里在范围内的（与同步同一谓词，一条 SQL）。 */
export async function employeesInScope(tx: Tx, scope: ModuleScope, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = rows<{ id: string }>(
    await tx.execute(sql`SELECT e.id FROM employment_employees e
      WHERE e.id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[]) AND ${scopeSql(scope, { person: sql`e.id` })}`),
  );
  return new Set(found.map((r) => r.id));
}

/**
 * 精细化权限下一批员工里在操作人 360 范围内的（第 5 轮 R4-P2-2）：已挂接 360 人员的按该人员的可见性判定（与人员
 * 列表、回补筛选同一谓词，含创建人维度），尚未挂接的没有人员可判，按员工判定（与自动添加选候选同一口径）。
 * 未生效（admin.people 为空）时返回 null，调用方不另加限制。
 */
export async function fineEmployees(tx: Tx, admin: Admin, ids: readonly string[]): Promise<Set<string> | null> {
  if (!admin.people) return null;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const linked = rows<{ id: string; employee_id: string }>(
    await tx.execute(sql`SELECT p.id, p.employee_id FROM survey360_people p
      WHERE p.employee_id = ANY(${`{${unique.join(',')}}`}::uuid[])`),
  );
  const visible = await visiblePersonIds(
    tx,
    admin,
    linked.map((p) => p.id),
  );
  const linkedIds = new Set(linked.map((p) => p.employee_id));
  const unlinked = await employeesInScope(
    tx,
    admin.people,
    unique.filter((id) => !linkedIds.has(id)),
  );
  return new Set([...linked.filter((p) => visible.has(p.id)).map((p) => p.employee_id), ...unlinked]);
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

/** 单个员工在范围内的当前快照；范围外、离职或没有任职记录为 undefined。 */
async function snapshotIn(tx: Tx, ctx: Survey360Context, access: SyncAccess, employeeId: string) {
  return (await employeeSnapshots(tx, ctx, access, { only: employeeId })).items[0];
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

async function createSyncedPerson(tx: Tx, grant: WriteGrant, matchedBy: string[]) {
  const { ctx, snapshot } = grant;
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
 * 已挂接人员要按组织覆盖的值：可见字段与上级，有变化才返回（P2-7）；邮箱为空不覆盖（邮箱是键）。精细化下受限管理员
 * 不改邮箱：占用者可能是其看不到的人员，改与不改都会暴露占用（第 6 轮 R5-P2-1）。
 */
async function changesOf(tx: Tx, ctx: Survey360Context, person: PersonRow, snapshot: EmployeeSnapshot) {
  const keepEmail = !!ctx.admin.people;
  const values: Partial<PersonRow> = Object.fromEntries(
    Object.entries(snapshot.values).filter(([key, value]) => !(key === 'email' && (!value || keepEmail))),
  );
  if (snapshot.managerId !== undefined)
    values.superiorPersonId = snapshot.managerId ? ((await linkedPerson(tx, snapshot.managerId))?.id ?? null) : null;
  if (values.superiorPersonId === person.id) values.superiorPersonId = null;
  const changed =
    Object.entries(values).some(([key, value]) => person[key as keyof PersonRow] !== value) || !person.emailLocked;
  return changed ? values : null;
}

/**
 * 已挂接人员按组织为准覆盖（同步、回补、导入同步）：先按命令开始时的权限与列出时的快照判断有没有变化——没有变化就不写，
 * 也就不需要许可；要写时取写入许可（加锁后的当前权限与当前快照），再由 writeLinked 按许可写入。范围在命令执行中收窄
 * 或员工已调出时返回 OUT_OF_SCOPE，不写。
 */
async function refreshLinked(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  personId: string,
  listed: EmployeeSnapshot,
): Promise<PersonRow | 'EMAIL_TAKEN' | typeof OUT_OF_SCOPE | null> {
  const person = await loadPerson(tx, personId);
  if (person.employeeId !== listed.employeeId) return OUT_OF_SCOPE;
  if (!(await changesOf(tx, ctx, person, listed))) return null;
  const grant = await authorizeTarget(tx, ctx, access, listed.employeeId);
  return grant ? writeLinked(tx, grant, person) : OUT_OF_SCOPE;
}

/**
 * 按许可覆盖已挂接人员（推进 revision、写审计）：人员须挂接在许可的员工上，并按许可里的当前人员范围可见；值取许可里的
 * 当前快照。没有变化返回 null；邮箱被其他人员占用时整条不写，返回 EMAIL_TAKEN。
 */
async function writeLinked(
  tx: Tx,
  grant: WriteGrant,
  person: PersonRow,
): Promise<PersonRow | 'EMAIL_TAKEN' | typeof OUT_OF_SCOPE | null> {
  const { ctx, snapshot } = grant;
  if (person.employeeId !== snapshot.employeeId || !(await personVisible(tx, ctx.admin, person))) return OUT_OF_SCOPE;
  const values = await changesOf(tx, ctx, person, snapshot);
  if (!values) return null;
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
  /**
   * 还有未处理的员工（员工 ID）或待回补上级的人员（backfill:员工 ID）时返回游标，下次以 after 续同步；全部处理完
   * 才返回 null（第 4 轮 R3-P2-4：没处理完不报结束）。
   */
  nextCursor: string | null;
}

/** 回补阶段的游标前缀：backfill: 表示从头回补，backfill:<员工 ID> 表示从该员工之后续回补。 */
export const BACKFILL_CURSOR = 'backfill:';

/** 请求里的续同步游标：员工 ID，或回补阶段的游标。 */
export const syncCursor = z.union([
  uuid,
  z
    .string()
    .regex(/^backfill:(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i)
    .transform((value) => value.toLowerCase()),
]);

/** 游标所指的员工 ID（回补阶段去掉前缀；从头回补为 null）。 */
function cursorEmployee(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  return cursor.startsWith(BACKFILL_CURSOR) ? cursor.slice(BACKFILL_CURSOR.length) || null : cursor;
}

async function conflictOf(tx: Tx, employeeId: string, status: 'pending' | 'ignored') {
  const [row] = await tx
    .select({ id: survey360SyncConflicts.id })
    .from(survey360SyncConflicts)
    .where(and(eq(survey360SyncConflicts.employeeId, employeeId), eq(survey360SyncConflicts.status, status)));
  return row;
}

/**
 * 未挂接员工的首次同步：被忽略的跳过；已有待处理冲突复用；查重命中登记冲突；否则新建。精细化下受限管理员一律跳过
 * PERSON_NOT_AVAILABLE（不查重、不登记冲突、不建人员；第 6 轮 R5-P2-1）。
 */
async function syncUnlinked(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  listed: EmployeeSnapshot,
  result: SyncResult,
) {
  const employeeId = listed.employeeId;
  if (ctx.admin.people) {
    result.skipped.push({ employeeId, reason: NOT_AVAILABLE });
    return null;
  }
  if (await conflictOf(tx, employeeId, 'ignored')) {
    result.skipped.push({ employeeId, reason: 'CONFLICT_IGNORED' });
    return null;
  }
  const pending = await conflictOf(tx, employeeId, 'pending');
  if (pending) {
    result.conflicts.push(pending.id);
    return null;
  }
  const listedBlocked = creatable(listed);
  if (listedBlocked) {
    result.skipped.push({ employeeId, reason: listedBlocked });
    return null;
  }
  // 要写（登记冲突 / 新建人员）了：取写入许可；范围收窄、精细化生效或员工已调出则跳过（F-043 第 3、4 轮）
  const grant = await authorizeTarget(tx, ctx, access, employeeId);
  if (!grant || grant.ctx.admin.people) {
    result.skipped.push({ employeeId, reason: NOT_AVAILABLE });
    return null;
  }
  const blocked = creatable(grant.snapshot);
  if (blocked) {
    result.skipped.push({ employeeId, reason: blocked });
    return null;
  }
  const candidates = await candidatesOf(tx, grant.snapshot);
  if (candidates.ids.length) {
    result.conflicts.push(await registerConflict(tx, grant, candidates));
    return null;
  }
  const created = await createSyncedPerson(tx, grant, []);
  result.created.push({ personId: created.id, employeeId });
  return created;
}

/** 按许可登记同步冲突（查重命中，待系统管理员确认）。 */
async function registerConflict(tx: Tx, grant: WriteGrant, candidates: { ids: string[]; matchedBy: string[] }) {
  const [conflict] = await tx
    .insert(survey360SyncConflicts)
    .values({
      tenantId: grant.ctx.tenantId,
      employeeId: grant.snapshot.employeeId,
      candidatePersonIds: candidates.ids,
      matchedBy: candidates.matchedBy,
    })
    .returning();
  await audit360(tx, actor(grant.ctx), {
    action: 'survey360.sync_conflict.create',
    objectType: 'survey360-sync-conflict',
    objectId: conflict!.id,
    before: null,
    after: conflictView(conflict!),
  });
  return conflict!.id;
}

/**
 * 一次同步：先列出本次要处理的全部目标——员工阶段的一页员工，员工阶段在本页结束时连同回补阶段的一页待补人员——
 * 一次取齐锁计划，再处理（F-043 第 3 轮：不在处理到一半时回头锁更早的员工）。
 */
export async function syncPeople(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  page: { after?: string | undefined; limit?: number | undefined },
): Promise<SyncResult> {
  const limit = page.limit ?? SYNC_LIMIT;
  const result: SyncResult = { created: [], updated: [], conflicts: [], skipped: [], nextCursor: null };
  // 回补阶段的游标：跳过员工阶段，从游标之后续回补
  if (page.after?.startsWith(BACKFILL_CURSOR)) {
    const targets = await backfillTargets(tx, ctx, access, cursorEmployee(page.after), limit, []);
    await lockPlan(
      tx,
      ctx.tenantId,
      targets.batch.map((t) => t.employee_id),
    );
    result.nextCursor = await backfillSuperiors(tx, ctx, access, targets, new Set(), result);
    return result;
  }
  const { items, nextCursor } = await employeeSnapshots(tx, ctx, access, { after: page.after, limit });
  const listed = items.map((i) => i.employeeId);
  const targets = nextCursor ? null : await backfillTargets(tx, ctx, access, null, limit, listed);
  await lockPlan(tx, ctx.tenantId, [...listed, ...(targets?.batch.map((t) => t.employee_id) ?? [])]);
  await syncPage(tx, ctx, access, items, result);
  result.nextCursor = nextCursor ?? (await backfillSuperiors(tx, ctx, access, targets!, new Set(listed), result));
  return result;
}

/**
 * 一页员工：先建 / 认领人员，再一次写入组织值与上级（上级可能是本页新建的人员）。
 * 已挂接的人员在写入前按目标人员范围复核（F-043）：精细化下员工信息范围内的员工，其 360 人员仍可能在操作人的 360 人员
 * 范围外（与人员列表同一谓词，含创建人维度），范围外的跳过、不写——回执 skipped 记一条（受限查看人看不到，见 syncView），
 * 并写审计 survey360.person.sync_skipped（对象 = 该 360 人员，只有能查看该人员日志的人看得到）。
 */
async function syncPage(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  items: readonly EmployeeSnapshot[],
  result: SyncResult,
) {
  const existingOf = new Map<string, PersonRow>();
  for (const snapshot of items) {
    const existing = await linkedPerson(tx, snapshot.employeeId);
    if (existing) existingOf.set(snapshot.employeeId, existing);
  }
  const visible = await visiblePersonIds(
    tx,
    ctx.admin,
    [...existingOf.values()].map((person) => person.id),
  );
  const linked: { snapshot: EmployeeSnapshot; personId: string; existed: boolean }[] = [];
  for (const snapshot of items) {
    const existing = existingOf.get(snapshot.employeeId);
    if (existing && !visible.has(existing.id)) {
      await skipOutOfPersonScope(tx, ctx, existing.id, existing.employeeId!, result);
    } else if (existing) {
      linked.push({ snapshot, personId: existing.id, existed: true });
    } else {
      const created = await syncUnlinked(tx, ctx, access, snapshot, result);
      if (created) linked.push({ snapshot, personId: created.id, existed: false });
    }
  }
  // 第二遍：上级可能是本批新建的人员；覆盖与上级一次写入
  for (const { snapshot, personId, existed } of linked) {
    const saved = await refreshLinked(tx, ctx, access, personId, snapshot);
    if (saved === OUT_OF_SCOPE) await skipOutOfPersonScope(tx, ctx, personId, snapshot.employeeId, result);
    else if (saved === 'EMAIL_TAKEN') result.skipped.push({ employeeId: snapshot.employeeId, reason: 'EMAIL_TAKEN' });
    else if (saved && existed) result.updated.push({ personId, employeeId: snapshot.employeeId });
  }
}

/** 目标人员在操作人的 360 人员范围外：不写，记回执 skipped 与审计（原因统一 PERSON_NOT_AVAILABLE，不泄露存在性）。 */
async function skipOutOfPersonScope(
  tx: Tx,
  ctx: Survey360Context,
  personId: string,
  employeeId: string,
  result?: SyncResult,
) {
  result?.skipped.push({ employeeId, reason: NOT_AVAILABLE });
  await audit360(tx, actor(ctx), {
    action: 'survey360.person.sync_skipped',
    objectType: 'survey360-person',
    objectId: personId,
    before: null,
    after: { id: personId, employeeId },
  });
}

/**
 * 员工当前任职的直线经理（与 findCurrentRecord 同一取数：当前有效的任职记录，最新快照覆盖记录上的值）；
 * column = dotted_manager_id 时取虚线经理（PR-B 报告转发“按汇报关系”）。
 */
export function currentManager(
  tenantId: string,
  employee: SQL,
  asOf: string,
  column: 'direct_manager_id' | 'dotted_manager_id' = 'direct_manager_id',
): SQL {
  const field = sql.raw(column);
  return sql`SELECT r.kind, CASE WHEN v.id IS NULL THEN r.${field} ELSE v.${field} END AS manager_id
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id = r.tenant_id AND t.record_id = r.id
    LEFT JOIN LATERAL (SELECT v.id, v.${field} FROM employment_payload_versions v
      WHERE v.tenant_id = r.tenant_id AND v.employee_id = r.employee_id AND v.business_id = r.id
        AND v.is_record_snapshot ORDER BY v.version_no DESC LIMIT 1) v ON true
    WHERE r.tenant_id = ${tenantId}::uuid AND r.employee_id = ${employee} AND t.valid_during @> ${asOf}::date
    ORDER BY t.start_date, t.sort_order, r.id LIMIT 1`;
}

interface BackfillTargets {
  readonly batch: readonly { id: string; employee_id: string }[];
  readonly next: string | null;
}

/**
 * 回补跨页上级的目标（第 3 轮 R2-P2-8；第 4 轮 R3-P2-3 / R3-P2-4）：按游标分页时下属可能在经理之前的页里同步，当时
 * 经理还没有 360 人员、上级留空。员工阶段结束后进入回补阶段，用 SQL 筛出待补的人员——挂接员工在员工信息范围内、
 * 人员在操作人 360 人员范围内（精细化，与人员列表同一谓词；范围外的不写入，也不列入回执，不暴露其存在）、上级为空、
 * 当前任职的直线经理不是本人且已挂接 360 人员——按员工 ID 游标分页，每页最多 limit 人；还有未补的返回回补游标。
 * 与员工阶段同一条命令时目标在处理之前列出（F-043 第 3 轮，一起取锁），经理是本页员工的也列入（本页可能为其
 * 新建人员），处理时再按实际情况判定。看不到直线经理字段的操作人无从回补。
 */
async function backfillTargets(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  after: string | null,
  limit: number,
  page: readonly string[],
): Promise<BackfillTargets> {
  if (access.recordFields !== undefined && !access.recordFields.has('directManagerId'))
    return { batch: [], next: null };
  const people = personFilter(ctx.admin);
  const manager = currentManager(ctx.tenantId, sql`p.employee_id`, tenantLocalDate(ctx.now, ctx.timezone));
  const pending = rows<{ id: string; employee_id: string }>(
    await tx.execute(sql`SELECT p.id, p.employee_id FROM survey360_people p CROSS JOIN LATERAL (${manager}) cur
      WHERE p.employee_id IS NOT NULL AND p.superior_person_id IS NULL
        AND ${scopeSql(access.scope, { person: sql`p.employee_id` })} ${people ? sql`AND ${people}` : sql``}
        ${after ? sql`AND p.employee_id > ${after}::uuid` : sql``}
        AND cur.kind NOT IN ('leave', 'retirement') AND cur.manager_id IS NOT NULL AND cur.manager_id <> p.employee_id
        AND (EXISTS (SELECT 1 FROM survey360_people m
          WHERE m.tenant_id = p.tenant_id AND m.employee_id = cur.manager_id AND m.id <> p.id)
          ${page.length ? sql`OR cur.manager_id = ANY(${uuids(page)})` : sql``})
      ORDER BY p.employee_id LIMIT ${limit + 1}`),
  );
  const batch = pending.slice(0, limit);
  return { batch, next: pending.length > limit ? `${BACKFILL_CURSOR}${batch.at(-1)!.employee_id}` : null };
}

/**
 * 回补：写入与同步同一路径（推进 revision、写字段级审计、计入 updated；组织邮箱被占用的计入 skipped；加锁后按当前
 * 权限复核）；本页刚同步过的人员已按本页结果写入，不重复。
 */
async function backfillSuperiors(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  targets: BackfillTargets,
  handled: ReadonlySet<string>,
  result: SyncResult,
): Promise<string | null> {
  for (const row of targets.batch) {
    if (handled.has(row.employee_id)) continue;
    const snapshot = await snapshotIn(tx, ctx, access, row.employee_id);
    if (!snapshot?.managerId || !(await linkedPerson(tx, snapshot.managerId))) continue;
    const saved = await refreshLinked(tx, ctx, access, row.id, snapshot);
    if (saved === OUT_OF_SCOPE) await skipOutOfPersonScope(tx, ctx, row.id, row.employee_id, result);
    else if (saved === 'EMAIL_TAKEN') result.skipped.push({ employeeId: row.employee_id, reason: 'EMAIL_TAKEN' });
    else if (saved) result.updated.push({ personId: row.id, employeeId: row.employee_id });
  }
  return targets.next;
}

export async function linkedPerson(tx: Tx, employeeId: string): Promise<PersonRow | undefined> {
  const [row] = await tx.select().from(survey360People).where(eq(survey360People.employeeId, employeeId));
  return row;
}

/**
 * 候选员工对应的 360 人员：已挂接的用该人员（精细化下按人员范围判定，看不到按范围外处理）；未同步的按同一规则判定能否
 * 新建（null = 可新建；看不到姓名 / 邮箱或有冲突的不建，返回原因）。精细化下受限管理员只用已挂接的人员，未同步的一律
 * PERSON_NOT_AVAILABLE（不查重、不建人员；第 6 轮 R5-P2-1）。
 */
async function personOutcome(tx: Tx, admin: Admin, snapshot: EmployeeSnapshot): Promise<PersonRow | string | null> {
  const existing = await linkedPerson(tx, snapshot.employeeId);
  if (existing) return (await personVisible(tx, admin, existing)) ? existing : 'OUT_OF_SCOPE';
  if (admin.people) return NOT_AVAILABLE;
  const blocked = creatable(snapshot);
  if (blocked) return blocked;
  if ((await candidatesOf(tx, snapshot)).ids.length) return 'SYNC_CONFLICT';
  return null;
}

/**
 * 按组织架构自动添加时取员工对应的 360 人员：先取写入许可（员工须在调用方的锁计划内，按操作人的当前权限与员工范围，
 * F-043 第 3、4 轮），再按 personOutcome 判定；可新建的按许可新建。员工已不在当前范围内返回 OUT_OF_SCOPE。
 */
export async function personForEmployee(
  tx: Tx,
  ctx: Survey360Context,
  access: SyncAccess,
  employeeId: string,
): Promise<PersonRow | string> {
  const grant = await authorizeTarget(tx, ctx, access, employeeId);
  if (!grant) return 'OUT_OF_SCOPE';
  return (await personOutcome(tx, grant.ctx.admin, grant.snapshot)) ?? createSyncedPerson(tx, grant, []);
}

/**
 * 导入评价者选择“同步”：已挂接人员按组织刷新（范围外的员工不刷新，P2-6）；人员与其挂接员工须在导入的锁计划内，
 * 写入前按当前权限复核（F-043 第 3 轮）。
 */
export async function refreshFromOrg(tx: Tx, ctx: Survey360Context, access: SyncAccess, person: PersonRow) {
  if (!person.employeeId) return person;
  const snapshot = await snapshotIn(tx, ctx, access, person.employeeId);
  if (!snapshot) return person;
  const saved = await refreshLinked(tx, ctx, access, person.id, snapshot);
  if (saved === OUT_OF_SCOPE) {
    // 写入前按当前权限复核发现已不在范围内：不刷新，沿用 sync_skipped 审计（精细化下整批在提交前另行复核）
    await skipOutOfPersonScope(tx, ctx, person.id, person.employeeId);
    return person;
  }
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
  // 锁计划（F-043 第 3 轮）：冲突员工与挂接目标人员先按全局顺序锁住
  await lockPlan(tx, ctx.tenantId, [conflict.employeeId], input.personId ? [input.personId] : []);
  // 取锁后、任何写入之前取写入许可（F-043 第 4 轮）：挂接 / 新建 / 忽略三个分支都经过，与有没有字段要刷新无关；
  // 失去功能权限整条回滚，员工已不在当前范围内按不存在处理
  const grant = await authorizeTarget(tx, ctx, access, conflict.employeeId);
  if (!grant) fail('NOT_FOUND', '冲突记录不存在');
  if (conflict.status !== 'pending') fail('CONFLICT', '冲突已处理', 'CONFLICT_CLOSED');
  requireRevision(conflict.revision, ctx.expectedRevision);
  let personId: string | null = null;
  if (input.action === 'link') personId = await linkConflict(tx, grant, conflict, input.personId);
  else if (input.action === 'create') {
    const blocked = creatable(grant.snapshot);
    if (blocked) fail('VALIDATION_FAILED', '看不到员工的姓名或邮箱，或员工没有邮箱，不能建 360 人员', blocked);
    if (await findPersonByEmail(tx, grant.snapshot.values.email!))
      fail('CONFLICT', '邮箱已被其他人员使用', 'EMAIL_TAKEN');
    personId = (await createSyncedPerson(tx, grant, conflict.matchedBy)).id;
  }
  return closeConflict(tx, grant, conflict, input.action, personId);
}

/** 按许可关闭冲突（已解决 / 已忽略），写审计。 */
async function closeConflict(
  tx: Tx,
  grant: WriteGrant,
  conflict: typeof survey360SyncConflicts.$inferSelect,
  action: 'link' | 'create' | 'ignore',
  personId: string | null,
) {
  const { ctx } = grant;
  const id = conflict.id;
  const [saved] = await tx
    .update(survey360SyncConflicts)
    .set({
      status: action === 'ignore' ? 'ignored' : 'resolved',
      resolution: action,
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

/**
 * 挂接目标：须是查重命中的候选；精细化权限下看不到的候选不列出，也不可挂接（与不是候选同一结果）。命令前（含幂等
 * 重放，第 4 轮）与命令内同一判定。
 */
async function linkTarget(tx: Tx, admin: Admin, candidates: readonly string[], personId: string | undefined) {
  const notCandidate = () => fail('VALIDATION_FAILED', '只能挂接到查重命中的人员', 'NOT_A_CANDIDATE');
  if (!personId || !candidates.includes(personId)) notCandidate();
  const person = await loadPerson(tx, personId!).catch(notCandidate);
  if (!(await personVisible(tx, admin, person))) notCandidate();
}

/** 冲突处理的载荷资源复核：选“挂接”时挂接目标按当前范围判定。 */
async function linkTargetRefs(tx: Tx, admin: Admin, id: string, input: { action: string; personId?: string }) {
  if (input.action !== 'link') return;
  const [conflict] = await tx
    .select({ candidates: survey360SyncConflicts.candidatePersonIds })
    .from(survey360SyncConflicts)
    .where(eq(survey360SyncConflicts.id, id));
  if (!conflict) fail('NOT_FOUND', '冲突记录不存在');
  await linkTarget(tx, admin, conflict.candidates, input.personId);
}

/** 按许可把冲突员工挂接到候选人员（挂接目标按许可里的当前人员范围复核），再按许可以组织值覆盖。 */
async function linkConflict(
  tx: Tx,
  grant: WriteGrant,
  conflict: typeof survey360SyncConflicts.$inferSelect,
  personId: string | undefined,
): Promise<string> {
  const { ctx } = grant;
  await linkTarget(tx, ctx.admin, conflict.candidatePersonIds, personId);
  if (await linkedPerson(tx, conflict.employeeId)) fail('CONFLICT', '该员工已挂接其他人员', 'EMPLOYEE_LINKED');
  const person = await loadPerson(tx, personId!, true);
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
  const refreshed = await writeLinked(tx, grant, saved!);
  // 挂接目标已按许可复核可见，OUT_OF_SCOPE 不会出现；出现即按冲突不存在处理，整个处理回滚
  if (refreshed === OUT_OF_SCOPE) fail('NOT_FOUND', '冲突记录不存在');
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
      async (tx, admin, tenant) => {
        requireUnrestricted(admin);
        return {
          items: await pendingConflicts(tx, await syncAccess(tx, deps, tenant, `${PERSONNEL_OBJECT}.list`), admin),
        };
      },
      conflictList,
    ),
  );
  module.post('/people/sync', (c) => {
    return write(
      c,
      deps,
      z.strictObject({ after: syncCursor.optional(), limit: z.int().min(1).max(SYNC_LIMIT).optional() }),
      async (tx, ctx, input) => syncPeople(tx, ctx, await syncAccess(tx, deps, ctx), input),
      {
        need: SYNC,
        fields: 'none', // 值取自组织员工（按操作人可见字段），after / limit 是协议参数（游标、页大小）
        revisionFree: true,
        preflight: async () => void (await routeEmployeeScope(c, deps)),
        present: async (viewer, body: SyncResult) => {
          const after = ((await jsonOrEmpty(c)) as { after?: string }).after?.toLowerCase();
          // 回执按查看人**当前**的员工信息范围裁剪（新请求与重放同一路径），不沿用路由层缓存的范围（F-043 第 2 轮 P2-2）
          const employees = await employeeScope(viewer.tx, deps, viewer.tenant);
          if (!employees) fail('FORBIDDEN', '无权查看组织员工信息', 'NO_EMPLOYEE_ACCESS');
          return syncView(viewer, employees, body, after);
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
        // 精细化下受限管理员不处理冲突（命令前与命令事务内，含重放；第 6 轮 R5-P2-1）
        guard: async (_tx, admin) => requireUnrestricted(admin),
        // 命令前（含命中台账的重放）按当前员工范围复核冲突员工：撤回范围后原键重放 404（第 3 轮 R2-P2-1）
        preflight: async () => {
          const scope = await routeEmployeeScope(c, deps);
          await withTenant(deps.db, tenantOf(c).tenantId, (tx) => requireConflictInScope(tx, scope, id));
        },
        // 挂接目标同样按当前人员范围复核：看不到即“不是候选”（第 4 轮）
        refs: (tx, admin, input) => linkTargetRefs(tx, admin, id, input),
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
const conflictList: Present = async (
  viewer,
  body: { items: { candidates: { personId: string; name: string }[] }[] },
) => {
  const fields = await viewer.fields('person');
  const maySeeName = fields === undefined || fields.has('name');
  const avatars = maySeeName
    ? await personAvatars(
        viewer.tx,
        viewer.tenant.tenantId,
        body.items.flatMap((item) => item.candidates.map((candidate) => candidate.personId)),
      )
    : new Map();
  return {
    items: body.items.map((item) => ({
      ...item,
      candidates: item.candidates.map((candidate) => ({
        ...pick(candidate, fields, { personId: 'id' }),
        ...(maySeeName ? { avatar: avatars.get(candidate.personId) ?? null } : {}),
      })),
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

/** 员工阶段从头续同步的游标：比任何员工 ID 都小（重放时游标员工已不在范围内、回执里也没有可退回的位置）。 */
const RESTART_CURSOR = '00000000-0000-0000-0000-000000000000';

/**
 * 重放时的游标：游标员工不在查看人当前范围内时不带出其 ID，也不因此报结束——员工阶段退回到回执里最后一个范围内
 * 员工、请求的 after 或从头；回补阶段退回到从头回补（已补的人员不再符合条件，不会重复写）。重复处理都是幂等的。
 */
function viewCursor(
  cursor: string | null,
  allowed: (employeeId: string) => boolean,
  listed: readonly string[],
  after: string | undefined,
): string | null {
  const position = cursorEmployee(cursor);
  if (!cursor || !position || allowed(position)) return cursor;
  if (cursor.startsWith(BACKFILL_CURSOR)) return BACKFILL_CURSOR;
  return listed.filter(allowed).sort().at(-1) ?? after ?? RESTART_CURSOR;
}

/**
 * 同步回执：返回前（新请求与重放同一路径）按当前员工范围复核（第 3 轮 R2-P2-1），范围外员工的新建 / 更新 / 冲突 /
 * 跳过条目去掉；人员条目另按精细化范围与人员字段裁剪；跳过条目与回补游标精细化下另按 fineEmployees 判定 360 范围
 * ——已挂接的按实际 360 人员及创建人，与筛选回补目标同一口径，合法的创建人范围不会被误判为范围外而把游标退回
 * 从头（第 5 轮 R4-P2-2）。游标见 viewCursor。
 */
async function syncView(viewer: Viewer, employees: ModuleScope, body: SyncResult, after: string | undefined) {
  const { tx, admin } = viewer;
  const conflictRows = body.conflicts.length
    ? await tx
        .select({ id: survey360SyncConflicts.id, employeeId: survey360SyncConflicts.employeeId })
        .from(survey360SyncConflicts)
        .where(inArray(survey360SyncConflicts.id, body.conflicts))
    : [];
  const conflictEmployee = new Map(conflictRows.map((c) => [c.id, c.employeeId]));
  const position = cursorEmployee(body.nextCursor);
  const listed = [...body.created, ...body.updated, ...body.skipped, ...conflictRows].map((e) => e.employeeId);
  const inScope = await employeesInScope(tx, employees, [...listed, ...(position ? [position] : [])]);
  const unlisted = [...body.skipped.map((e) => e.employeeId), ...(position ? [position] : [])];
  const fine = await fineEmployees(tx, admin, unlisted);
  const allowed = (id: string) => inScope.has(id) && (!fine || fine.has(id));
  const visible = await visiblePersonIds(
    tx,
    admin,
    [...body.created, ...body.updated].map((e) => e.personId),
  );
  const fields = await viewer.fields('person');
  const people = (list: SyncResult['created']) =>
    list
      .filter((e) => inScope.has(e.employeeId) && visible.has(e.personId))
      .map((e) => pick(e, fields, { personId: 'id' }));
  const cursorAllowed = (id: string) => (body.nextCursor?.startsWith(BACKFILL_CURSOR) ? allowed(id) : inScope.has(id));
  return {
    created: people(body.created),
    updated: people(body.updated),
    // 精细化下受限查看人不看冲突、跳过原因统一（与其新命令同一口径；重放当时不受限时的回执也一样，R5-P2-1）
    conflicts: admin.people ? [] : body.conflicts.filter((id) => inScope.has(conflictEmployee.get(id) ?? '')),
    skipped: restrictedSkips(
      admin,
      body.skipped.filter((e) => allowed(e.employeeId)),
    ),
    nextCursor: viewCursor(body.nextCursor, cursorAllowed, listed, after),
  };
}

/** 跳过原因：精细化下受限查看人一律 PERSON_NOT_AVAILABLE（冲突、邮箱占用等原因可能来自其看不到的人员）。 */
export function restrictedSkips<T extends { reason: string }>(admin: Admin, skipped: readonly T[]): T[] {
  return admin.people ? skipped.map((entry) => ({ ...entry, reason: NOT_AVAILABLE })) : [...skipped];
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
