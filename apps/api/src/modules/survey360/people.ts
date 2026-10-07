/**
 * 360 人员表（DEC-027）：内外部人员同一张表、邮箱为键、跨活动复用、外部人员可作评价对象。
 * 已同步人员的邮箱锁定（DEC-030 ③，AC-360-14），其余字段 360 端可改；与组织员工的同步见 sync.ts。
 */
import { and, eq, inArray, sql, survey360PersonLinkLogs, survey360People, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { resolveModuleScopeInTransaction, scopeSql } from '../permission/module-access.js';
import { finePermission } from './access.js';
import { pageQuery, uuidParam } from '../job/context.js';
import {
  actor,
  type Admin,
  audit360,
  BUTTONS,
  email,
  fail,
  optionalText,
  read,
  requireNewObject,
  requireRevision,
  type Survey360Context,
  type Writer,
  OBJECTS,
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

/**
 * 人员表可见范围（DEC-280⑤）：默认对有人员查看权的 360 身份全部可见（手机号不单独脱敏，只按字段权限裁剪）；
 * 开启“精细化权限”后，没有“全部活动”按钮的人只看挂接员工在其（用户 × Survey360 应用）数据范围内的人员，
 * 未挂接员工的外部人员看不到。返回 null 表示不限制。
 */
async function peopleScope(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, admin: Admin, page?: string) {
  if (admin.allActivities || !(await finePermission(tx))) return null;
  const code = OBJECTS.person.code;
  const scope = await resolveModuleScopeInTransaction(deps, tenant, tx, code, page && `${code}.${page}`);
  if (scope.all) return null;
  // 360 人员按挂接的员工判断：组织类条件取员工当前任职组织（与员工信息同一套 SQL，scope-persons.ts）
  const personQuery = {
    kind: 'organization' as const,
    tenantId: tenant.tenantId,
    asOf: tenantLocalDate(deps.clock(), tenant.timezone),
  };
  const terms = (scope.terms ?? []).map((term) =>
    term.dimension === 'management' || term.dimension === 'organization' ? { ...term, personQuery } : term,
  );
  // 汇报关系维度：360 人员不是员工信息对象，解析器不给出汇报线人员查询，按 fail-closed 不放行
  const columns = { person: sql`p.employee_id`, creator: sql`p.created_by` };
  return sql`(p.employee_id IS NOT NULL AND ${scopeSql({ ...scope, terms }, columns)})`;
}

/** 当前操作人可见的人员；看不到按不存在处理（404）。 */
export async function visiblePerson(
  tx: Tx,
  deps: TenantRouteDeps,
  tenant: TenantContext,
  admin: Admin,
  id: string,
  page?: string,
): Promise<PersonRow> {
  const person = await loadPerson(tx, id);
  const filter = await peopleScope(tx, deps, tenant, admin, page);
  if (filter) {
    const [row] = rows<{ id: string }>(
      await tx.execute(sql`SELECT p.id FROM survey360_people p WHERE p.id = ${id}::uuid AND ${filter}`),
    );
    if (!row) fail('NOT_FOUND', '人员不存在');
  }
  return person;
}

const VIEW = { object: 'person' } as const;

export function registerPeopleRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerPeopleLists(module, deps);
  registerPersonReads(module, deps);
  registerPeopleWrites(module, deps);
}

function registerPeopleLists(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin, tenant) => {
        const page = pageQuery(c);
        const q = c.req.query('q')?.trim();
        const search = q ? sql`(p.name ILIKE ${`%${q}%`} OR p.email ILIKE ${`%${q}%`})` : sql`true`;
        const scope = (await peopleScope(tx, deps, tenant, admin, 'list')) ?? sql`true`;
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
      },
      'person',
    ),
  );
}

function registerPersonReads(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/people/:id', (c) =>
    read(
      c,
      deps,
      VIEW,
      async (tx, admin, tenant) => personView(await visiblePerson(tx, deps, tenant, admin, uuidParam(c), 'detail')),
      'person',
    ),
  );
  module.get('/people/:id/link-logs', (c) =>
    read(
      c,
      deps,
      // 关联日志属“从系统管理中同步人员信息”（DEC-280①：一般管理员看不到）
      { object: 'person', button: BUTTONS.sync },
      async (tx, admin, tenant) => {
        const person = await visiblePerson(tx, deps, tenant, admin, uuidParam(c), 'detail');
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
      { need: { object: 'person', operation: 'create' }, fields: (input) => input, status: 201 },
    ),
  );
  module.put('/people/:id', (c) => {
    const id = uuidParam(c);
    const tenant = tenantOf(c);
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
        guard: async (tx, admin) => void (await visiblePerson(tx, deps, tenant, admin, id)),
        fields: (input) => input,
      },
    );
  });
}
