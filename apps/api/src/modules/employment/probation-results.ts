/**
 * 转正“试用结果”字典（R2 BE-3，差距表 B7；原站标准字段 ProbationResult，类型码 2 = 选项，取值未取证）。
 * 规格 29 / 15 没有列出取值，按派发单保守做法：租户字典，预置正常 / 提前 / 延期转正三项（PB-R5 会生成转正记录的意见），
 * 形态照离职字典（exit-dictionaries.ts）：编码租户内唯一（不分大小写）、保存后不可改；可新增、改名、停用 / 启用、调顺序，
 * 不提供删除（被转正记录引用的编码不能消失）。写入由路由按 tenant.employment.configuration.write 授权。
 */
import { getTableColumns } from 'drizzle-orm';
import { and, asc, employmentProbationResults as table, eq, sql, type Tx } from '@italent/db';
import { PROBATION_RESULT_PRESETS } from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { registerSeed, type SeedWriteContext } from '../../seeds/registry.js';
import { assertRevision } from './context.js';
import type { EmploymentContext } from './types.js';

/** 字典由管理员手工维护、不提供删除，上限在新增时拦，列表在上限内整份返回、不分页。 */
export const PROBATION_RESULT_LIMIT = 200;
const AUDIT = { action: 'probation_result.save', objectType: 'probation_result' } as const;

const createInput = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  displayOrder: z.int().min(0).max(100000).default(0),
});
const updateInput = z.strictObject({
  code: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  displayOrder: z.int().min(0).max(100000).optional(),
});

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '试用结果字段不合法', parsed.error.issues);
  return parsed.data;
}
/** 路由在字段授权之前先做严格校验：多余字段 400，而不是被当作无权字段 403。 */
export function parseProbationResultInput(raw: unknown, mode: 'create' | 'update'): Record<string, unknown> {
  return mode === 'create' ? parse(createInput, raw) : parse(updateInput, raw);
}

const { tenantId: _tenant, createdAt: _created, updatedAt: _updated, ...columns } = getTableColumns(table);

export async function listProbationResults(tx: Tx, tenantId: string, filter: { readonly enabled?: boolean } = {}) {
  const rows = await tx
    .select(columns)
    .from(table)
    .where(
      and(eq(table.tenantId, tenantId), filter.enabled === undefined ? undefined : eq(table.enabled, filter.enabled)),
    )
    .orderBy(asc(table.displayOrder), asc(table.code), asc(table.id))
    .limit(PROBATION_RESULT_LIMIT + 1);
  if (rows.length > PROBATION_RESULT_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '试用结果字典超过单次读取上限');
  return rows;
}

async function findByCode(tx: Tx, tenantId: string, code: string) {
  const [row] = await tx
    .select(columns)
    .from(table)
    .where(and(eq(table.tenantId, tenantId), sql`lower(${table.code}) = lower(${code})`));
  return row;
}

/** 同一租户的字典写入串行化：新增前查重与唯一索引一起保证同编码并发新增恰一条成功。 */
const lockDictionary = (tx: Tx, tenantId: string) => advisoryLock(tx, asUuid(tenantId), ':probation-results');

async function atLimit(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.tenantId, tenantId));
  return row!.count >= PROBATION_RESULT_LIMIT;
}

export async function saveProbationResult(tx: Tx, ctx: EmploymentContext, raw: unknown, id?: string) {
  await lockDictionary(tx, ctx.tenantId);
  const writer = writerOf(ctx);
  if (!id) {
    const input = parse(createInput, raw);
    assertRevision(ctx.expectedRevision, 0);
    if (await findByCode(tx, ctx.tenantId, input.code))
      throw new AppError('CONFLICT', '试用结果编码已存在', { reason: 'PROBATION_RESULT_CODE_TAKEN', code: input.code });
    if (await atLimit(tx, ctx.tenantId))
      throw new AppError('CONFLICT', '试用结果已达上限', {
        reason: 'PROBATION_RESULT_LIMIT_REACHED',
        limit: PROBATION_RESULT_LIMIT,
      });
    const [after] = await tx
      .insert(table)
      .values({ ...input, tenantId: ctx.tenantId, createdAt: ctx.now, updatedAt: ctx.now })
      .returning(columns);
    await audit(tx, writer, after!.id, null, after!);
    return after!;
  }
  const input = parse(updateInput, raw);
  const [before] = await tx
    .select(columns)
    .from(table)
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)));
  if (!before) throw new AppError('NOT_FOUND', '试用结果不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  const { code, ...changes } = input;
  if (code !== undefined && code !== before.code)
    throw new AppError('VALIDATION_FAILED', '试用结果编码保存后不可修改', {
      reason: 'PROBATION_RESULT_CODE_IMMUTABLE',
    });
  const [after] = await tx
    .update(table)
    .set({ ...changes, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)))
    .returning(columns);
  await audit(tx, writer, id, before, after!);
  return after!;
}

/** 新选用时只能选启用项：编码不存在 → PROBATION_RESULT_UNKNOWN，已停用 → PROBATION_RESULT_DISABLED，均为 400。返回库里的编码写法。 */
export async function requireEnabledProbationResult(tx: Tx, tenantId: string, code: string): Promise<string> {
  const entry = await findByCode(tx, tenantId, code);
  if (!entry || !entry.enabled)
    throw new AppError('VALIDATION_FAILED', entry ? '试用结果已停用' : '试用结果不存在', {
      reason: entry ? 'PROBATION_RESULT_DISABLED' : 'PROBATION_RESULT_UNKNOWN',
      code,
    });
  return entry.code;
}

const writerOf = (ctx: EmploymentContext): SeedWriteContext => ({
  tenantId: ctx.tenantId,
  actorUserId: auditActor(ctx.userId),
  commandId: ctx.commandId,
  now: ctx.now,
});

async function audit(tx: Tx, writer: SeedWriteContext, id: string, before: object | null, after: object) {
  await recordAudit(tx, {
    tenantId: writer.tenantId,
    actorUserId: writer.actorUserId,
    action: AUDIT.action,
    objectType: AUDIT.objectType,
    objectId: id,
    before,
    after,
    commandId: writer.commandId,
    occurredAt: writer.now,
  });
}

// ---- 预置项（DEC-361 登记表：新租户开通即装，存量租户经平台回补命令补装；只补缺失编码，不覆盖租户改名 / 停用）----
// 模块名单列（不与离职字典同属 'employment'）：按模块补装 employment 时的报告保持离职字典一项（AC-DM-19）
registerSeed({
  module: 'employment-probation',
  key: 'probation-results',
  version: 1,
  codes: PROBATION_RESULT_PRESETS.map((preset) => preset.code),
  existing: async (tx, tenantId) => {
    const rows = await tx
      .select({ code: sql<string>`lower(${table.code})` })
      .from(table)
      .where(eq(table.tenantId, tenantId));
    return new Set(rows.map((row) => row.code));
  },
  install: async (tx, write, missing) => {
    await lockDictionary(tx, write.tenantId);
    for (const [index, preset] of PROBATION_RESULT_PRESETS.entries()) {
      if (!missing.includes(preset.code)) continue;
      const [after] = await tx
        .insert(table)
        .values({
          tenantId: write.tenantId,
          code: preset.code,
          name: preset.name,
          displayOrder: (index + 1) * 10,
          createdAt: write.now,
          updatedAt: write.now,
        })
        .onConflictDoNothing()
        .returning(columns);
      if (after) await audit(tx, write, after.id, null, after);
    }
    return { skipped: [] };
  },
});
