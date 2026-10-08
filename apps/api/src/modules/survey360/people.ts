/**
 * 360 人员表（DEC-027）：内外部人员同一张表、邮箱为键、跨活动复用、外部人员可作评价对象。
 * 已同步人员的邮箱锁定（DEC-030 ③，AC-360-14），其余字段 360 端可改；与组织员工的同步见 sync.ts。
 */
import { and, eq, inArray, sql, survey360PersonLinkLogs, survey360People, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { scopeAllowsInTransaction, scopeSql } from '../permission/module-access.js';
import { pageQuery, uuidParam } from '../job/context.js';
import {
  actor,
  type Admin,
  audit360,
  BUTTONS,
  email,
  fail,
  optionalText,
  type Present,
  read,
  requireNewObject,
  requireRevision,
  type Survey360Context,
  type Writer,
  rows,
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

/**
 * 上级须存在；精细化权限下还须可见（看不到与不存在同一结果，不暴露存在性）。编辑 / 新建人员的载荷资源复核
 * （命令前，含幂等重放，第 4 轮 R3-P2-1）与命令内同一判定。
 */
async function requireSuperior(tx: Tx, id: string | null | undefined, self?: string, admin?: Admin) {
  if (!id) return;
  if (id === self) fail('VALIDATION_FAILED', '上级不能是本人', 'SUPERIOR_SELF');
  const missing = () => fail('VALIDATION_FAILED', '上级人员不存在', 'SUPERIOR_NOT_FOUND');
  const superior = await loadPerson(tx, id).catch(missing);
  if (admin && !(await personVisible(tx, admin, superior))) missing();
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
  await requireSuperior(tx, patch.superiorPersonId, current.id, ctx.admin);
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

/**
 * 人员可见（DEC-280⑤、DEC-289①）：默认对有人员查看权的 360 身份全部可见（手机号不单独脱敏，只按字段权限裁剪）；
 * 精细化权限生效时（admin.people 非空，路由层 requestScope 取得并按 360 人员改写，见 context.ts）只看挂接员工在
 * 范围内的人员，未挂接员工的外部人员看不到；活动内的评价对象 / 评价者同此口径。列表与点查同一 SQL 谓词。
 */
export function personFilter(admin: Admin, alias: SQL = sql`p`): SQL | null {
  if (!admin.people) return null;
  const columns = { person: sql`${alias}.employee_id`, creator: sql`${alias}.created_by` };
  return sql`(${alias}.employee_id IS NOT NULL AND ${scopeSql(admin.people, columns)})`;
}

export async function personVisible(tx: Tx, admin: Admin, person: PersonRow): Promise<boolean> {
  if (!admin.people) return true;
  if (!person.employeeId) return false;
  return scopeAllowsInTransaction(tx, admin.people, { personId: person.employeeId, creatorId: person.createdBy });
}

/** 一批人员里查看人可见的（与列表同一谓词，一条 SQL）。 */
export async function visiblePersonIds(tx: Tx, admin: Admin, ids: readonly string[]): Promise<Set<string>> {
  const filter = personFilter(admin);
  if (!filter || ids.length === 0) return new Set(ids);
  const found = rows<{ id: string }>(
    await tx.execute(sql`SELECT p.id FROM survey360_people p
      WHERE p.id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[]) AND ${filter}`),
  );
  return new Set(found.map((r) => r.id));
}

/** 尚未建 360 人员的员工（自动添加的候选）：只按员工判断，不按将来的创建人放行。 */
export async function employeeVisible(tx: Tx, admin: Admin, employeeId: string): Promise<boolean> {
  return !admin.people || scopeAllowsInTransaction(tx, admin.people, { personId: employeeId });
}

/** 当前操作人可见的人员；看不到按不存在处理（404）。 */
export async function visiblePerson(tx: Tx, admin: Admin, id: string, message = '人员不存在'): Promise<PersonRow> {
  const person = await loadPerson(tx, id).catch(() => fail('NOT_FOUND', message));
  if (!(await personVisible(tx, admin, person))) fail('NOT_FOUND', message);
  return person;
}

/**
 * 精细化权限生效时不新建 360 人员（第 3 轮 R2-P2-7）：不论邮箱是否已被看不到的人员占用都同一结果，不暴露存在性；
 * 录入邮箱属于可见人员时照常复用（调用方先查）。
 */
export function requireCreatable(admin: Admin): void {
  if (admin.people) fail('FORBIDDEN', '开启精细化权限后只能选择可见的人员，不能新建人员', 'PERSON_NOT_AVAILABLE');
}

/** 关联日志：员工挂接字段按查看人的人员字段裁剪，其余是日志协议字段。 */
const linkLogs: Present = async (viewer, body: { items: Record<string, unknown>[] }) => {
  const fields = await viewer.fields('person');
  const linkage = ['employeeId', 'previousEmployeeId'];
  return {
    items: body.items.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !linkage.includes(key) || !fields || fields.has(key))),
    ),
  };
};

const VIEW = { object: 'person' } as const;

export function registerPeopleRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerPeopleLists(module, deps);
  registerPersonReads(module, deps);
  registerPeopleWrites(module, deps);
}

function registerPeopleLists(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people', (c) =>
    read(c, deps, VIEW, async (tx, admin) => {
      const page = pageQuery(c);
      const q = c.req.query('q')?.trim();
      const search = q ? sql`(p.name ILIKE ${`%${q}%`} OR p.email ILIKE ${`%${q}%`})` : sql`true`;
      const scope = personFilter(admin) ?? sql`true`;
      const ids = rows<{ id: string }>(
        await tx.execute(sql`SELECT p.id FROM survey360_people p WHERE ${search} AND ${scope}
            ORDER BY p.created_at, p.id LIMIT ${page.limit} OFFSET ${page.offset}`),
      ).map((r) => r.id);
      const items = ids.length
        ? await tx
            .select()
            .from(survey360People)
            .where(inArray(survey360People.id, ids))
            .orderBy(survey360People.createdAt, survey360People.id)
        : [];
      return { items: items.map(personView), page: page.page, pageSize: page.pageSize };
    }),
  );
}

function registerPersonReads(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people/:id', (c) =>
    read(c, deps, VIEW, async (tx, admin) => personView(await visiblePerson(tx, admin, uuidParam(c)))),
  );
  module.get('/people/:id/link-logs', (c) =>
    read(
      c,
      deps,
      // 关联日志属“从系统管理中同步人员信息”（DEC-280①：一般管理员看不到）
      { object: 'person', button: BUTTONS.sync },
      async (tx, admin) => {
        const person = await visiblePerson(tx, admin, uuidParam(c));
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
      linkLogs,
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
      {
        need: { object: 'person', operation: 'create' },
        fields: 'body',
        guard: async (_tx, admin) => requireCreatable(admin),
        refs: (tx, admin, input) => requireSuperior(tx, input.superiorPersonId, undefined, admin),
        status: 201,
      },
    ),
  );
  module.put('/people/:id', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      personInput.partial(),
      async (tx, ctx, input) => {
        const current = await loadPerson(tx, id, true);
        requireRevision(current.revision, ctx.expectedRevision);
        return personView(await updatePerson(tx, ctx, current, input));
      },
      {
        need: { object: 'person', operation: 'update' },
        fields: 'body',
        guard: async (tx, admin) => void (await visiblePerson(tx, admin, id)),
        refs: (tx, admin, input) => requireSuperior(tx, input.superiorPersonId, id, admin),
      },
    );
  });
}
