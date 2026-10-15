/**
 * R2-T03 离职三个字典（B60～62：离职类型 / 离职原因 / 离职去向）的读写、选择校验、名称回显与预置项登记。
 * docs/08_设计/R2-T03_离职管理设计.md §2.1：照合同主数据（contracts/configuration.ts saveMaster）的形态——
 * 编码租户内唯一（不分大小写）、保存后不可改；可新增、改名、停用 / 启用、调顺序；不提供删除（被引用的编码不能消失）。
 * 字典是配置对象：写入由路由按 tenant.employment.configuration.write 授权，审计 exit_dictionary.save（DEC-203 配置日志）。
 */
import { and, asc, eq, exitReasons, exitTypes, exitWhereabouts, inArray, sql, type Tx } from '@italent/db';
import { EXIT_DICTIONARY_KINDS, EXIT_DICTIONARY_PRESETS, type ExitDictionaryKind } from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { registerSeed } from '../../seeds/registry.js';
import { assertRevision } from './context.js';
import type { EmploymentContext } from './types.js';

const TABLES = { types: exitTypes, reasons: exitReasons, whereabouts: exitWhereabouts } as const;
/** 单个字典的读取上限：字典由管理员手工维护，超过即视为异常数据，不做分页。 */
const DICTIONARY_LIMIT = 500;
export const EXIT_DICTIONARY_AUDIT = { action: 'exit_dictionary.save', objectType: 'exit_dictionary' } as const;

export interface ExitDictionaryEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly revision: number;
}

const createInput = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  displayOrder: z.int().min(0).max(100000).default(0),
});
// 更新可只传要改的项；带 code 只能是原值（大小写一致），用于前端整行回传
const updateInput = z.strictObject({
  code: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  displayOrder: z.int().min(0).max(100000).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '离职字典字段不合法', parsed.error.issues);
  return parsed.data;
}
/** 路由在字段授权之前先做严格校验：多余字段 400，而不是被当作无权字段 403。 */
export function parseExitDictionaryInput(raw: unknown, mode: 'create' | 'update'): Record<string, unknown> {
  return mode === 'create' ? parse(createInput, raw) : parse(updateInput, raw);
}

export function exitDictionaryKind(value: string | undefined): ExitDictionaryKind {
  if (!(EXIT_DICTIONARY_KINDS as readonly string[]).includes(value ?? '')) {
    throw new AppError('VALIDATION_FAILED', '离职字典不存在', { reason: 'EXIT_DICTIONARY_KIND_INVALID' });
  }
  return value as ExitDictionaryKind;
}

const columns = (kind: ExitDictionaryKind) => {
  const t = TABLES[kind];
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    enabled: t.enabled,
    displayOrder: t.displayOrder,
    revision: t.revision,
  };
};

export async function listExitDictionary(
  tx: Tx,
  tenantId: string,
  kind: ExitDictionaryKind,
  filter: { readonly enabled?: boolean } = {},
): Promise<ExitDictionaryEntry[]> {
  const t = TABLES[kind];
  const rows = await tx
    .select(columns(kind))
    .from(t)
    .where(and(eq(t.tenantId, tenantId), filter.enabled === undefined ? undefined : eq(t.enabled, filter.enabled)))
    .orderBy(asc(t.displayOrder), asc(t.code), asc(t.id))
    .limit(DICTIONARY_LIMIT + 1);
  if (rows.length > DICTIONARY_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '离职字典超过单次读取上限');
  return rows;
}

/** 同一租户同一字典的写入串行化：新增前查重与唯一索引一起保证同编码并发新增恰一条成功。 */
async function lockDictionary(tx: Tx, tenantId: string, kind: ExitDictionaryKind) {
  await advisoryLock(tx, asUuid(tenantId), `:exit-dictionary:${kind}`);
}

async function findByCode(tx: Tx, tenantId: string, kind: ExitDictionaryKind, code: string) {
  const t = TABLES[kind];
  const [row] = await tx
    .select(columns(kind))
    .from(t)
    .where(and(eq(t.tenantId, tenantId), sql`lower(${t.code}) = lower(${code})`));
  return row;
}

export async function saveExitDictionaryEntry(
  tx: Tx,
  ctx: EmploymentContext,
  kind: ExitDictionaryKind,
  raw: unknown,
  id?: string,
): Promise<ExitDictionaryEntry> {
  const t = TABLES[kind];
  await lockDictionary(tx, ctx.tenantId, kind);
  if (!id) {
    const input = parse(createInput, raw);
    assertRevision(ctx.expectedRevision, 0);
    if (await findByCode(tx, ctx.tenantId, kind, input.code)) {
      throw new AppError('CONFLICT', '离职字典编码已存在', { reason: 'EXIT_DICTIONARY_CODE_TAKEN', code: input.code });
    }
    const [after] = await tx
      .insert(t)
      .values({ ...input, tenantId: ctx.tenantId, createdAt: ctx.now, updatedAt: ctx.now })
      .returning(columns(kind));
    await audit(tx, ctx, after!.id, null, after!);
    return after!;
  }
  const input = parse(updateInput, raw);
  const [before] = await tx
    .select(columns(kind))
    .from(t)
    .where(and(eq(t.tenantId, ctx.tenantId), eq(t.id, id)));
  if (!before) throw new AppError('NOT_FOUND', '离职字典项不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  const { code, ...changes } = input;
  if (code !== undefined && code !== before.code) {
    throw new AppError('VALIDATION_FAILED', '离职字典编码保存后不可修改', { reason: 'EXIT_DICTIONARY_CODE_IMMUTABLE' });
  }
  const [after] = await tx
    .update(t)
    .set({ ...changes, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(t.tenantId, ctx.tenantId), eq(t.id, id)))
    .returning(columns(kind));
  await audit(tx, ctx, id, before, after!);
  return after!;
}

async function audit(tx: Tx, ctx: EmploymentContext, id: string, before: object | null, after: object) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: EXIT_DICTIONARY_AUDIT.action,
    objectType: EXIT_DICTIONARY_AUDIT.objectType,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

/**
 * 业务侧新选用字典项时调用（DM-R1：只能选启用项）：编码不存在 → EXIT_DICTIONARY_UNKNOWN，已停用 → EXIT_DICTIONARY_DISABLED，
 * 均为 400。已保存单据上的旧编码不经此校验（只对新选用、改值的字段调用）。
 */
export async function assertExitDictionaryEnabled(
  tx: Tx,
  tenantId: string,
  kind: ExitDictionaryKind,
  code: string,
): Promise<void> {
  const entry = await findByCode(tx, tenantId, kind, code);
  if (!entry || !entry.enabled) {
    throw new AppError('VALIDATION_FAILED', entry ? '离职字典项已停用' : '离职字典项不存在', {
      reason: entry ? 'EXIT_DICTIONARY_DISABLED' : 'EXIT_DICTIONARY_UNKNOWN',
      dictionary: kind,
      code,
    });
  }
}

/** 已保存单据的显示名称：按编码取名称，停用项照常返回（§2.1）；不存在的编码不出现在结果里。 */
export async function exitDictionaryNames(
  tx: Tx,
  tenantId: string,
  kind: ExitDictionaryKind,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return new Map();
  const t = TABLES[kind];
  const rows = await tx
    .select({ code: t.code, name: t.name })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), inArray(t.code, wanted)));
  return new Map(rows.map((row) => [row.code, row.name]));
}

// ---- 预置项（DEC-361 登记表：新租户开通即装，存量租户经平台回补命令补装；只补缺失编码，不覆盖租户改名 / 停用）----
const presetCode = (kind: ExitDictionaryKind, code: string) => `${kind}:${code}`;

registerSeed({
  module: 'employment',
  key: 'exit-dictionaries',
  version: 1,
  codes: EXIT_DICTIONARY_PRESETS.map((preset) => presetCode(preset.kind, preset.code)),
  existing: async (tx, tenantId) => {
    const have = new Set<string>();
    for (const kind of EXIT_DICTIONARY_KINDS) {
      const t = TABLES[kind];
      const rows = await tx
        .select({ code: t.code })
        .from(t)
        .where(eq(t.tenantId, tenantId))
        .limit(DICTIONARY_LIMIT + 1);
      for (const row of rows) have.add(presetCode(kind, row.code.toLowerCase()));
    }
    return have;
  },
  install: async (tx, write, missing) => {
    for (const [index, preset] of EXIT_DICTIONARY_PRESETS.entries()) {
      if (!missing.includes(presetCode(preset.kind, preset.code))) continue;
      // 与管理员新增同锁；管理员已手工建了同编码（不分大小写）时不插入、不覆盖
      await lockDictionary(tx, write.tenantId, preset.kind);
      const [after] = await tx
        .insert(TABLES[preset.kind])
        .values({
          tenantId: write.tenantId,
          code: preset.code,
          name: preset.name,
          displayOrder: (index + 1) * 10,
          createdAt: write.now,
          updatedAt: write.now,
        })
        .onConflictDoNothing()
        .returning(columns(preset.kind));
      if (!after) continue;
      await recordAudit(tx, {
        tenantId: write.tenantId,
        actorUserId: write.actorUserId,
        action: EXIT_DICTIONARY_AUDIT.action,
        objectType: EXIT_DICTIONARY_AUDIT.objectType,
        objectId: after.id,
        before: null,
        after,
        commandId: write.commandId,
        occurredAt: write.now,
      });
    }
  },
});
