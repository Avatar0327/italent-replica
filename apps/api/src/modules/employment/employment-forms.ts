/** F-321：任职、兼职与 F-263 共用的租户字典。引用只用稳定编码，名称 / 类别均读当前字典。 */
import { and, asc, employmentForms as table, eq, sql, type Tx } from '@italent/db';
import { EMPLOYMENT_FORM_PRESETS } from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { registerSeed, type SeedWriteContext } from '../../seeds/registry.js';
import { auditActor } from '../../system-actor.js';
import { validIsoDate } from '../org/read-model.js';
import { assertRevision } from './context.js';
import type { EmploymentContext } from './types.js';

const LIMIT = 500;
const columns = {
  id: table.id,
  code: table.code,
  name: table.name,
  category: table.category,
  displayOrder: table.displayOrder,
  effectiveDate: table.effectiveDate,
  expiryDate: table.expiryDate,
  enabled: table.enabled,
  remark: table.remark,
  revision: table.revision,
};
const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const inputSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  name: z.string().trim().min(1).max(200),
  category: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
  displayOrder: z.int().min(0).max(100000),
  effectiveDate: date,
  expiryDate: date,
  enabled: z.boolean(),
  remark: z.string().max(2000).nullable().optional(),
});
export function parseEmploymentForm(raw: unknown, update = false) {
  const parsed = (update ? inputSchema.partial() : inputSchema).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '用工形式字段不合法', parsed.error.issues);
  return parsed.data;
}

export async function listEmploymentForms(tx: Tx, tenantId: string) {
  return tx
    .select(columns)
    .from(table)
    .where(eq(table.tenantId, tenantId))
    .orderBy(asc(table.displayOrder), asc(table.code))
    .limit(LIMIT);
}

/** F-263 校验入口：在调用方 withTenant 事务中校验至多 500 个编码；不存在 / 跨租户 / 停用均 422。 */
export async function requireEnabledEmploymentForms(tx: Tx, tenantId: string, codes: readonly string[]) {
  if (!codes.length) return;
  if (codes.length > LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '用工形式校验超过上限');
  const found = await tx
    .select({ code: table.code, enabled: table.enabled })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), sql`${table.code} IN ${codes}`))
    .for('share');
  const byCode = new Map(found.map((row) => [row.code, row.enabled]));
  for (const code of codes) {
    if (byCode.get(code) === true) continue;
    throw new AppError('EMPLOYMENT_FORM_INVALID', '用工形式不存在或已停用', {
      field: 'employmentForm',
      reason: byCode.get(code) === false ? 'EMPLOYMENT_FORM_DISABLED' : 'EMPLOYMENT_FORM_UNKNOWN',
    });
  }
}

/** 只接受本租户引用；null / 未给不选用字典，空字符串并非清空。供任职 / 兼职所有写入共用。 */
export async function validateEmploymentForm(tx: Tx, tenantId: string, code: unknown) {
  if (code === null || code === undefined) return;
  if (typeof code !== 'string') throw new AppError('EMPLOYMENT_FORM_INVALID', '用工形式必须是字典编码');
  await requireEnabledEmploymentForms(tx, tenantId, [code]);
}

/** 名称补充发生在字段权限裁剪后；停用项仍可显示历史名称。遍历已裁剪的任职、兼职及前驱快照。 */
export async function employmentFormNames(tx: Tx, tenantId: string, value: unknown): Promise<unknown> {
  const codes = new Set<string>();
  function visit(node: unknown, names?: ReadonlyMap<string, string>): unknown {
    if (Array.isArray(node)) return node.map((child) => visit(child, names));
    if (!node || typeof node !== 'object' || node instanceof Date) return node;
    const object = node as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child, names)]));
    if (typeof object.employmentForm === 'string') {
      codes.add(object.employmentForm);
      if (names) result.employmentFormName = names.get(object.employmentForm) ?? null;
    }
    return result;
  }
  visit(value);
  if (!codes.size) return value;
  const found = await tx
    .select({ code: table.code, name: table.name })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), sql`${table.code} IN ${[...codes]}`));
  return visit(value, new Map(found.map((row) => [row.code, row.name])));
}

const lock = (tx: Tx, tenantId: string) => advisoryLock(tx, asUuid(tenantId), ':employment-forms');
async function audit(tx: Tx, writer: SeedWriteContext, id: string, before: object | null, after: object) {
  await recordAudit(tx, {
    tenantId: writer.tenantId,
    actorUserId: writer.actorUserId,
    action: 'employment_form.save',
    objectType: 'employment_form',
    objectId: id,
    before,
    after,
    commandId: writer.commandId,
    occurredAt: writer.now,
  });
}

export async function saveEmploymentForm(tx: Tx, ctx: EmploymentContext, raw: unknown, id?: string) {
  await lock(tx, ctx.tenantId);
  const input = parseEmploymentForm(raw, id !== undefined);
  const [before] = id
    ? await tx
        .select(columns)
        .from(table)
        .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)))
        .for('update')
    : [];
  if (id && !before) throw new AppError('NOT_FOUND', '用工形式不存在');
  assertRevision(ctx.expectedRevision, before?.revision ?? 0);
  if (before && input.code !== undefined && input.code !== before.code)
    throw new AppError('VALIDATION_FAILED', '用工形式编码保存后不可修改');
  const next = { ...before, ...input } as z.infer<typeof inputSchema>;
  if (next.effectiveDate > next.expiryDate) throw new AppError('VALIDATION_FAILED', '失效日期不得早于生效日期');
  const existing = await listEmploymentForms(tx, ctx.tenantId);
  if (!id && existing.length >= LIMIT) throw new AppError('CONFLICT', '用工形式已达上限');
  if (existing.some((row) => row.id !== id && row.code === next.code))
    throw new AppError('CONFLICT', '用工形式编码已存在');
  const changes = { ...next, remark: next.remark ?? null, updatedAt: ctx.now, revision: (before?.revision ?? 0) + 1 };
  const [after] = id
    ? await tx
        .update(table)
        .set(changes)
        .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)))
        .returning(columns)
    : await tx
        .insert(table)
        .values({ ...changes, tenantId: ctx.tenantId, createdAt: ctx.now })
        .returning(columns);
  await audit(
    tx,
    { tenantId: ctx.tenantId, actorUserId: auditActor(ctx.userId), commandId: ctx.commandId, now: ctx.now },
    after!.id,
    before ?? null,
    after!,
  );
  return after!;
}

registerSeed({
  module: 'employment-forms',
  key: 'employment-forms',
  version: 1,
  codes: EMPLOYMENT_FORM_PRESETS.map((item) => item.code),
  existing: async (tx, tenantId) => new Set((await listEmploymentForms(tx, tenantId)).map((row) => row.code)),
  install: async (tx, writer, missing) => {
    await lock(tx, writer.tenantId);
    for (const preset of EMPLOYMENT_FORM_PRESETS) {
      if (!missing.includes(preset.code)) continue;
      const [after] = await tx
        .insert(table)
        .values({ ...preset, tenantId: writer.tenantId, createdAt: writer.now, updatedAt: writer.now })
        .onConflictDoNothing()
        .returning(columns);
      if (after) await audit(tx, writer, after.id, null, after);
    }
    return { skipped: [] };
  },
});
