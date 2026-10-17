/**
 * Offer 拒绝原因 / 失效原因两个字典（A37；34 §2.1 转移表单、OF-R7 失效表单）的读写、选用校验与预置项登记。
 * 形态照离职字典（employment/exit-dictionaries.ts）：编码租户内唯一（不分大小写）、保存后不可改；可新增、改名、停用 / 启用、
 * 调顺序；不提供删除（已保存 Offer 引用的编码不能消失）。写入审计 offer_dictionary.save。
 */
import { and, asc, eq, inArray, offerDictionaryItems, sql, type Tx } from '@italent/db';
import { OFFER_DICTIONARY_KINDS, OFFER_DICTIONARY_PRESETS, type OfferDictionaryKind } from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { registerSeed, type SeedSkip, type SeedWriteContext } from '../../seeds/registry.js';
import { auditActor } from '../../system-actor.js';
import { assertOfferRevision, type OfferContext } from './context.js';

/** 每个字典最多 500 项：不提供删除，上限在新增时拦（含预置补装），列表在上限内整份返回、不分页。 */
export const OFFER_DICTIONARY_LIMIT = 500;
export const OFFER_DICTIONARY_AUDIT = { action: 'offer_dictionary.save', objectType: 'offer_dictionary' } as const;

const t = offerDictionaryItems;
const columns = {
  id: t.id,
  code: t.code,
  name: t.name,
  enabled: t.enabled,
  displayOrder: t.displayOrder,
  revision: t.revision,
};
const name = z.string().trim().min(1).max(200);
const order = z.int().min(0).max(100000);
const createInput = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name,
  enabled: z.boolean().default(true),
  displayOrder: order.default(0),
});
// 更新可只传要改的项；带 code 只能是原值，用于前端整行回传
const updateInput = z.strictObject({
  code: z.string().trim().min(1).max(100).optional(),
  name: name.optional(),
  enabled: z.boolean().optional(),
  displayOrder: order.optional(),
});

/** 路由在字段授权之前先做严格校验：多余字段 400，而不是被当作无权字段 403。 */
export function parseOfferDictionaryInput(raw: unknown, mode: 'create' | 'update'): Record<string, unknown> {
  const parsed = (mode === 'create' ? createInput : updateInput).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Offer 字典字段不合法', parsed.error.issues);
  return parsed.data;
}

export function offerDictionaryKind(value: string | undefined): OfferDictionaryKind {
  if (!(OFFER_DICTIONARY_KINDS as readonly string[]).includes(value ?? ''))
    throw new AppError('VALIDATION_FAILED', 'Offer 字典不存在', { reason: 'OFFER_DICTIONARY_KIND_INVALID' });
  return value as OfferDictionaryKind;
}

const ofKind = (tenantId: string, kind: OfferDictionaryKind) => and(eq(t.tenantId, tenantId), eq(t.kind, kind));

export async function listOfferDictionary(tx: Tx, tenantId: string, kind: OfferDictionaryKind, enabled?: boolean) {
  return tx
    .select(columns)
    .from(t)
    .where(and(ofKind(tenantId, kind), enabled === undefined ? undefined : eq(t.enabled, enabled)))
    .orderBy(asc(t.displayOrder), asc(t.code), asc(t.id))
    .limit(OFFER_DICTIONARY_LIMIT);
}

/** 同一租户同一字典的写入串行化：查重与唯一索引一起保证同编码并发新增恰一条成功。 */
const lockDictionary = (tx: Tx, tenantId: string, kind: OfferDictionaryKind) =>
  advisoryLock(tx, asUuid(tenantId), `:offer-dictionary:${kind}`);

async function atLimit(tx: Tx, tenantId: string, kind: OfferDictionaryKind) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(t)
    .where(ofKind(tenantId, kind));
  return row!.count >= OFFER_DICTIONARY_LIMIT;
}

async function findByCode(tx: Tx, tenantId: string, kind: OfferDictionaryKind, code: string) {
  const [row] = await tx
    .select(columns)
    .from(t)
    .where(and(ofKind(tenantId, kind), sql`lower(${t.code}) = lower(${code})`));
  return row;
}

/**
 * 转移 / 失效表单选用的原因只能是启用项（BE-14a2）：不存在 → OFFER_DICTIONARY_UNKNOWN，停用 → OFFER_DICTIONARY_DISABLED，
 * 均为 400；返回字典里的规范编码（编码不分大小写）。
 */
export async function requireEnabledOfferReason(tx: Tx, tenantId: string, kind: OfferDictionaryKind, code: string) {
  const entry = await findByCode(tx, tenantId, kind, code);
  if (!entry?.enabled)
    throw new AppError('VALIDATION_FAILED', entry ? 'Offer 字典项已停用' : 'Offer 字典项不存在', {
      reason: entry ? 'OFFER_DICTIONARY_DISABLED' : 'OFFER_DICTIONARY_UNKNOWN',
      dictionary: kind,
      code,
    });
  return entry.code;
}

export async function saveOfferDictionaryEntry(
  tx: Tx,
  ctx: OfferContext,
  kind: OfferDictionaryKind,
  input: Record<string, unknown>,
  id?: string,
) {
  await lockDictionary(tx, ctx.tenantId, kind);
  const writer = writerOf(ctx);
  if (!id) {
    const values = createInput.parse(input);
    assertOfferRevision(ctx.expectedRevision, 0);
    if (await findByCode(tx, ctx.tenantId, kind, values.code))
      throw new AppError('CONFLICT', 'Offer 字典编码已存在', { reason: 'OFFER_DICTIONARY_CODE_TAKEN' });
    if (await atLimit(tx, ctx.tenantId, kind))
      throw new AppError('CONFLICT', 'Offer 字典项已达上限', { reason: 'OFFER_DICTIONARY_LIMIT_REACHED' });
    const [after] = await tx
      .insert(t)
      .values({ ...values, kind, tenantId: ctx.tenantId, createdAt: ctx.now, updatedAt: ctx.now })
      .returning(columns);
    await audit(tx, writer, after!.id, null, after!);
    return after!;
  }
  const { code, ...changes } = updateInput.parse(input);
  const [before] = await tx
    .select(columns)
    .from(t)
    .where(and(ofKind(ctx.tenantId, kind), eq(t.id, id)));
  if (!before) throw new AppError('NOT_FOUND', 'Offer 字典项不存在');
  assertOfferRevision(ctx.expectedRevision, before.revision);
  if (code !== undefined && code !== before.code)
    throw new AppError('VALIDATION_FAILED', 'Offer 字典编码保存后不可修改', {
      reason: 'OFFER_DICTIONARY_CODE_IMMUTABLE',
    });
  const [after] = await tx
    .update(t)
    .set({ ...changes, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(t.tenantId, ctx.tenantId), eq(t.id, id)))
    .returning(columns);
  await audit(tx, writer, id, before, after!);
  return after!;
}

const writerOf = (ctx: OfferContext): SeedWriteContext => ({
  tenantId: ctx.tenantId,
  actorUserId: auditActor(ctx.userId),
  commandId: ctx.commandId,
  now: ctx.now,
});

async function audit(tx: Tx, writer: SeedWriteContext, id: string, before: object | null, after: object) {
  await recordAudit(tx, {
    tenantId: writer.tenantId,
    actorUserId: writer.actorUserId,
    ...OFFER_DICTIONARY_AUDIT,
    objectId: id,
    before,
    after,
    commandId: writer.commandId,
    occurredAt: writer.now,
  });
}

// ---- 预置项（DEC-361：新租户开通即装，存量租户经平台回补补装；只补缺失编码，不覆盖租户改名 / 停用）----
const presetCode = (kind: OfferDictionaryKind, code: string) => `${kind}:${code}`;

registerSeed({
  module: 'offer',
  key: 'offer-dictionaries',
  version: 1,
  codes: OFFER_DICTIONARY_PRESETS.map((preset) => presetCode(preset.kind, preset.code)),
  existing: async (tx, tenantId) => {
    const rows = await tx
      .select({ kind: t.kind, code: sql<string>`lower(${t.code})` })
      .from(t)
      .where(
        and(
          eq(t.tenantId, tenantId),
          inArray(
            sql`lower(${t.code})`,
            OFFER_DICTIONARY_PRESETS.map((p) => p.code),
          ),
        ),
      );
    return new Set(rows.map((row) => presetCode(row.kind as OfferDictionaryKind, row.code)));
  },
  install: async (tx, write, missing) => {
    const skipped: SeedSkip[] = [];
    for (const [index, preset] of OFFER_DICTIONARY_PRESETS.entries()) {
      const code = presetCode(preset.kind, preset.code);
      if (!missing.includes(code)) continue;
      await lockDictionary(tx, write.tenantId, preset.kind);
      if (await atLimit(tx, write.tenantId, preset.kind)) {
        skipped.push({ code, reason: 'OFFER_DICTIONARY_LIMIT_REACHED' });
        continue;
      }
      const [after] = await tx
        .insert(t)
        .values({
          tenantId: write.tenantId,
          kind: preset.kind,
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
    return { skipped };
  },
});
