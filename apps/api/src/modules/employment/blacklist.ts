/**
 * R2 BE-8a 黑名单（B68；差距表“补证结论 R2f”、DEC-569）：名单读写与再入职拦截。
 * - 名单：选人员加黑时快照人员档案的姓名 / 证件号 / 手机 / 邮箱（之后档案改了也不回写），不选人员时手填姓名与至少一项联系标识；
 *   加黑日期由系统写（手动加黑 = 租户今天；离职加黑由 BE-8b 传离职生效日）；有效截止日期为空 = 永久，原因不推导期限。
 * - 移出只改状态、保留记录；删除整行删除，审计留快照（AGENTS §5）。批量移出 / 删除整批成功或整批失败。
 * - 拦截（DEC-569）：新周期入职类保存时在编制校验之后调用 assertNotBlacklisted，命中有效黑名单 → 409，事务整体回滚。
 * 接线点（BE-8b）：离职生效写名单调用 addBlacklistEntry(source = manual / auto_rule, blacklistDate = 离职生效日)。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import {
  BLACKLIST_BATCH_LIMIT,
  BLACKLIST_NOTE_MAX,
  BLACKLIST_REASON_CODES,
  BLACKLIST_SOURCE_CODES,
  BLACKLIST_STATUSES,
  blacklistBlockedMessage,
  type BlacklistSource,
  MODULE_OBJECTS,
  tenantLocalDate,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { validIsoDate } from '../org/read-model.js';
import { assertRevision } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const BLACKLIST_OBJECT = MODULE_OBJECTS.blacklist.code;
export const BLACKLIST_AUDIT_TYPE = 'blacklist';

export interface BlacklistEntry {
  readonly id: string;
  readonly employeeId: string | null;
  readonly name: string;
  readonly idNumber: string | null;
  readonly mobilePhone: string | null;
  readonly email: string | null;
  readonly reason: string;
  readonly blacklistDate: string;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly status: string;
  readonly removedAt: string | null;
  readonly revision: number;
}

const isoDate = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(BLACKLIST_NOTE_MAX).nullable();
const createInput = z
  .strictObject({
    employeeId: z
      .string()
      .refine(isUuid, '人员标识必须为 UUID')
      .transform((value) => value.toLowerCase())
      .optional(),
    name: text(100).optional(),
    idNumber: text(64).optional(),
    mobilePhone: text(32).optional(),
    email: text(254).optional(),
    reason: z.enum(BLACKLIST_REASON_CODES),
    expiryDate: isoDate.nullable().optional(),
    note: note.optional(),
  })
  .superRefine((value, ctx) => {
    const typed = [value.name, value.idNumber, value.mobilePhone, value.email].some((field) => field !== undefined);
    if (value.employeeId && typed)
      ctx.addIssue({ code: 'custom', message: '选择人员加黑时姓名与联系标识取自人员档案，不能手填' });
    if (!value.employeeId && !value.name) ctx.addIssue({ code: 'custom', message: '未选择人员时须填写姓名' });
    if (!value.employeeId && !value.idNumber && !value.mobilePhone && !value.email)
      ctx.addIssue({ code: 'custom', message: '未选择人员时须填写证件号码、手机号或邮箱之一' });
  });
export type BlacklistCreateInput = z.infer<typeof createInput>;

const updateInput = z
  .strictObject({ reason: z.enum(BLACKLIST_REASON_CODES).optional(), expiryDate: isoDate.nullable().optional(), note })
  .partial()
  .refine((value) => Object.keys(value).length > 0, '至少修改一项');
export type BlacklistUpdateInput = z.infer<typeof updateInput>;

const batchInput = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          id: z
            .string()
            .refine(isUuid)
            .transform((value) => value.toLowerCase()),
          revision: z.int().min(1),
        }),
      )
      .min(1)
      .max(BLACKLIST_BATCH_LIMIT),
  })
  .refine(({ items }) => new Set(items.map((item) => item.id)).size === items.length, '同一条记录不能重复出现');
export type BlacklistBatchInput = z.infer<typeof batchInput>;

const listQuery = z.strictObject({
  status: z.enum(BLACKLIST_STATUSES).default('active'),
  name: z.string().trim().min(1).max(100).optional(),
  idNumber: z.string().trim().min(1).max(64).optional(),
  mobilePhone: z.string().trim().min(1).max(32).optional(),
  reason: z.enum(BLACKLIST_REASON_CODES).optional(),
  source: z.enum(BLACKLIST_SOURCE_CODES).optional(),
});
export type BlacklistFilter = z.infer<typeof listQuery>;
/** 按敏感字段筛选须对该字段有查看权（与人员信息列表同一口径）：路由据此先校验字段。 */
export const BLACKLIST_FILTER_FIELDS = ['name', 'idNumber', 'mobilePhone', 'reason', 'source'] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', message, parsed.error.issues);
  return parsed.data;
}
export const parseBlacklistCreate = (raw: unknown) => parse(createInput, raw, '黑名单字段不合法');
export const parseBlacklistUpdate = (raw: unknown) => parse(updateInput, raw, '黑名单字段不合法');
export const parseBlacklistBatch = (raw: unknown) =>
  parse(batchInput, raw, `须为 1～${BLACKLIST_BATCH_LIMIT} 条不重复的黑名单记录`);
export const parseBlacklistFilter = (raw: Record<string, string>) => parse(listQuery, raw, '黑名单筛选条件不合法');

/**
 * 联系标识（证件号 / 手机 / 邮箱）的单一口径（#387 第 1 轮 P2-1）：去首尾空白后空串一律视为“没有该标识”（NULL），
 * 写入快照、查重、筛选、拦截匹配都只经这两个函数取值；表上同口径的 CHECK 与部分唯一索引保证库里没有空白标识。
 * 证件号、邮箱不分大小写比较。NULL 与任何值比较都不成立，所以缺失的标识永远不会“相等”。
 */
type IdentityField = 'idNumber' | 'mobilePhone' | 'email';
const CASELESS: Readonly<Record<IdentityField, boolean>> = { idNumber: true, mobilePhone: false, email: true };
const storedIdentity = (value: SQL) => sql`NULLIF(btrim(${value}), '')`;
/** 写入前的同一口径（值在 JS 侧时）：去首尾空白，空串为 null。 */
const blankToNull = (value: string | null | undefined) => value?.trim() || null;
const identityKey = (field: IdentityField, value: SQL) =>
  CASELESS[field] ? sql`lower(${storedIdentity(value)})` : storedIdentity(value);

const COLUMNS = sql`id, employee_id AS "employeeId", name, id_number AS "idNumber", mobile_phone AS "mobilePhone",
  email, reason, blacklist_date::text AS "blacklistDate", expiry_date::text AS "expiryDate", note, source, status,
  removed_at AS "removedAt", revision`;

export async function listBlacklist(
  tx: Tx,
  tenantId: string,
  filter: BlacklistFilter,
  page: { readonly limit: number; readonly offset: number },
): Promise<BlacklistEntry[]> {
  const conditions = [sql`tenant_id = ${tenantId}`, sql`status = ${filter.status}`];
  if (filter.name) conditions.push(sql`strpos(lower(name), lower(${filter.name})) > 0`);
  if (filter.idNumber)
    conditions.push(
      sql`${identityKey('idNumber', sql`id_number`)} = ${identityKey('idNumber', sql`${filter.idNumber}`)}`,
    );
  if (filter.mobilePhone)
    conditions.push(
      sql`${identityKey('mobilePhone', sql`mobile_phone`)} = ${identityKey('mobilePhone', sql`${filter.mobilePhone}`)}`,
    );
  if (filter.reason) conditions.push(sql`reason = ${filter.reason}`);
  if (filter.source) conditions.push(sql`source = ${filter.source}`);
  return rowsOf<BlacklistEntry>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM employment_blacklist WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY blacklist_date DESC, created_at DESC, id DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

/** 同一租户的名单写入串行化：查重与部分唯一索引一起保证同一人员 / 证件号同时只有一条在名单。 */
async function lockBlacklist(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':employment-blacklist');
}

async function personSnapshot(tx: Tx, tenantId: string, employeeId: string) {
  const [person] = rowsOf<{ name: string; idNumber: string | null; mobilePhone: string | null; email: string | null }>(
    await tx.execute(sql`
      SELECT COALESCE(NULLIF(btrim(v.name), ''), e.name) AS name, ${storedIdentity(sql`v.id_number`)} AS "idNumber",
        ${storedIdentity(sql`v.mobile_phone`)} AS "mobilePhone", ${storedIdentity(sql`v.email`)} AS email
      FROM employment_employees e
      LEFT JOIN LATERAL (SELECT pv.name, pv.id_number, pv.mobile_phone, pv.email FROM personnel_employee_versions pv
        WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
      WHERE e.tenant_id = ${tenantId} AND e.id = ${employeeId}::uuid`),
  );
  if (!person) throw new AppError('NOT_FOUND', '员工不存在');
  return person;
}

function assertExpiry(blacklistDate: string, expiryDate: string | null | undefined) {
  if (expiryDate && expiryDate < blacklistDate)
    throw new AppError('VALIDATION_FAILED', '有效截止日期不能早于加黑日期', {
      reason: 'BLACKLIST_EXPIRY_BEFORE_DATE',
    });
}

async function assertNotDuplicated(tx: Tx, tenantId: string, employeeId: string | null, idNumber: string | null) {
  const [duplicate] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM employment_blacklist WHERE tenant_id = ${tenantId} AND status = 'active'
      AND ((${employeeId}::uuid IS NOT NULL AND employee_id = ${employeeId}::uuid)
        OR ${identityKey('idNumber', sql`id_number`)} = ${identityKey('idNumber', sql`${idNumber}::text`)})
      LIMIT 1`),
  );
  if (duplicate) throw new AppError('CONFLICT', '此人员已在黑名单中', { reason: 'BLACKLIST_DUPLICATE' });
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `blacklist.${action}`,
    objectType: BLACKLIST_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function readEntry(tx: Tx, tenantId: string, id: string, lock = false): Promise<BlacklistEntry | undefined> {
  const [row] = rowsOf<BlacklistEntry>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM employment_blacklist WHERE tenant_id = ${tenantId} AND id = ${id}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  return row;
}

/**
 * 加入黑名单（手动新增与 BE-8b 离职加黑共用）：If-Match 须为 0；重复（同一人员或同一证件号已在名单）409 BLACKLIST_DUPLICATE。
 * options.blacklistDate 缺省为租户今天。
 */
export async function addBlacklistEntry(
  tx: Tx,
  ctx: EmploymentContext,
  input: BlacklistCreateInput,
  options: { readonly source?: BlacklistSource; readonly blacklistDate?: string } = {},
): Promise<BlacklistEntry> {
  await lockBlacklist(tx, ctx.tenantId);
  assertRevision(ctx.expectedRevision, 0);
  const employeeId = input.employeeId ?? null;
  const source = employeeId ? await personSnapshot(tx, ctx.tenantId, employeeId) : input;
  const person = {
    name: source.name!,
    idNumber: blankToNull(source.idNumber),
    mobilePhone: blankToNull(source.mobilePhone),
    email: blankToNull(source.email),
  };
  const blacklistDate = options.blacklistDate ?? tenantLocalDate(ctx.now, ctx.timezone);
  assertExpiry(blacklistDate, input.expiryDate);
  await assertNotDuplicated(tx, ctx.tenantId, employeeId, person.idNumber);
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO employment_blacklist(id, tenant_id, employee_id, name, id_number, mobile_phone, email, reason,
      blacklist_date, expiry_date, note, source, created_by, created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${employeeId}::uuid, ${person.name}, ${person.idNumber},
      ${person.mobilePhone}, ${person.email}, ${input.reason}, ${blacklistDate}::date,
      ${input.expiryDate ?? null}::date, ${input.note || null}, ${options.source ?? 'manual'},
      ${auditActor(ctx.userId)}::uuid, ${ctx.now.toISOString()}::timestamptz, ${ctx.now.toISOString()}::timestamptz)`);
  const after = (await readEntry(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'create', id, null, after);
  return after;
}

async function lockedEntry(tx: Tx, ctx: EmploymentContext, id: string, revision: number) {
  const before = await readEntry(tx, ctx.tenantId, id, true);
  if (!before) throw new AppError('NOT_FOUND', '黑名单记录不存在');
  assertRevision(revision, before.revision);
  return before;
}
function requireActive(entry: BlacklistEntry) {
  if (entry.status !== 'active')
    throw new AppError('CONFLICT', '黑名单记录已移出', { reason: 'BLACKLIST_REMOVED', id: entry.id });
}

/** 编辑原因 / 有效截止日期 / 说明（If-Match = 当前 revision）；已移出的记录不能编辑。 */
export async function updateBlacklistEntry(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  input: BlacklistUpdateInput,
): Promise<BlacklistEntry> {
  const before = await lockedEntry(tx, ctx, id, ctx.expectedRevision);
  requireActive(before);
  const next = {
    reason: input.reason ?? before.reason,
    expiryDate: input.expiryDate === undefined ? before.expiryDate : input.expiryDate,
    note: input.note === undefined ? before.note : input.note || null,
  };
  assertExpiry(before.blacklistDate, next.expiryDate);
  await tx.execute(sql`UPDATE employment_blacklist SET reason = ${next.reason}, expiry_date = ${next.expiryDate}::date,
    note = ${next.note}, revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const after = (await readEntry(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'update', id, before, after);
  return after;
}

/** 整批按 id 排序加锁后逐条校验，任一条不存在 / revision 过期 / 状态不符即整批回滚。 */
async function lockBatch(tx: Tx, ctx: EmploymentContext, input: BlacklistBatchInput, active: boolean) {
  const entries: BlacklistEntry[] = [];
  for (const item of input.items.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const entry = await lockedEntry(tx, ctx, item.id, item.revision);
    if (active) requireActive(entry);
    entries.push(entry);
  }
  return entries;
}

export async function removeBlacklistEntries(tx: Tx, ctx: EmploymentContext, input: BlacklistBatchInput) {
  const items: BlacklistEntry[] = [];
  for (const before of await lockBatch(tx, ctx, input, true)) {
    await tx.execute(sql`UPDATE employment_blacklist SET status = 'removed',
      removed_at = ${ctx.now.toISOString()}::timestamptz, removed_by = ${auditActor(ctx.userId)}::uuid,
      revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${before.id}::uuid`);
    const after = (await readEntry(tx, ctx.tenantId, before.id))!;
    await audit(tx, ctx, 'remove', before.id, before, after);
    items.push(after);
  }
  return { items };
}

export async function deleteBlacklistEntries(tx: Tx, ctx: EmploymentContext, input: BlacklistBatchInput) {
  const entries = await lockBatch(tx, ctx, input, false);
  for (const before of entries) {
    await tx.execute(
      sql`DELETE FROM employment_blacklist WHERE tenant_id = ${ctx.tenantId} AND id = ${before.id}::uuid`,
    );
    await audit(tx, ctx, 'delete', before.id, before, null);
  }
  return { deleted: entries.length };
}

/**
 * 判定日在有效黑名单内的匹配记录：同一人员，或姓名相同且证件号 / 手机 / 邮箱任一相同（docs/02_业务建模/34 OF-R2）。
 * 标识按 identityKey 口径比较：空白视为没有，证件号 / 邮箱不分大小写。
 */
export async function findEffectiveBlacklistEntry(tx: Tx, tenantId: string, employeeId: string, today: string) {
  const [hit] = rowsOf<{ name: string; reason: string }>(
    await tx.execute(sql`
      WITH person AS (
        SELECT e.id, btrim(COALESCE(NULLIF(btrim(v.name), ''), e.name)) AS name,
          ${identityKey('idNumber', sql`v.id_number`)} AS id_number,
          ${identityKey('mobilePhone', sql`v.mobile_phone`)} AS mobile_phone,
          ${identityKey('email', sql`v.email`)} AS email
        FROM employment_employees e
        LEFT JOIN LATERAL (SELECT pv.name, pv.id_number, pv.mobile_phone, pv.email FROM personnel_employee_versions pv
          WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
        WHERE e.tenant_id = ${tenantId} AND e.id = ${employeeId}::uuid
      )
      SELECT b.name, b.reason FROM employment_blacklist b CROSS JOIN person p
      WHERE b.tenant_id = ${tenantId} AND b.status = 'active'
        AND (b.expiry_date IS NULL OR b.expiry_date >= ${today}::date)
        AND (b.employee_id = p.id OR (btrim(b.name) = p.name AND (
          ${identityKey('idNumber', sql`b.id_number`)} = p.id_number
          OR ${identityKey('mobilePhone', sql`b.mobile_phone`)} = p.mobile_phone
          OR ${identityKey('email', sql`b.email`)} = p.email)))
      ORDER BY (b.employee_id = p.id) IS TRUE DESC, b.blacklist_date DESC, b.id LIMIT 1`),
  );
  return hit;
}

/** 再入职拦截（DEC-569）：新周期入职类保存时调用；不受自动加黑开关影响。 */
export async function assertNotBlacklisted(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<void> {
  const hit = await findEffectiveBlacklistEntry(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  if (hit)
    throw new AppError('CONFLICT', blacklistBlockedMessage(hit.name, hit.reason), { reason: 'EMPLOYEE_BLACKLISTED' });
}
