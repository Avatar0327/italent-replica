import { isActiveAccount } from '../approval/resolver.js';
import {
  and,
  eq,
  contractSettings,
  contractRenewalRules,
  contractRenewalDetails,
  contractTypes,
  contractCompanies,
  sql,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { audit, revision, rowsOf, type ContractContext } from './context.js';
import { parse, settingsSchema, ruleSchema } from './input.js';

export async function settings(tx: Tx, tenantId: string) {
  const [value] = await tx.select().from(contractSettings).where(eq(contractSettings.tenantId, tenantId));
  return (
    value ?? {
      tenantId,
      revision: 0,
      autoRenew: false,
      autoTerminate: false,
      autoNumber: true,
      accumulateRehire: true,
      postExitTypeIds: [],
      renewalTypeIds: [],
      indefiniteTypeIds: [],
      uniqueFields: ['number'],
    }
  );
}
export async function verifyIds(tx: Tx, tenantId: string, table: string, ids: readonly string[]) {
  if (!ids.length) return;
  const rows = rowsOf(
    await tx.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}
    AND id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  if (rows.length !== new Set(ids).size) throw new AppError('VALIDATION_FAILED', '引用不存在或不属于当前租户');
}
/** 合同配置（设置、类型、规则）的写入串行化（租户级）。 */
export async function lockContractConfig(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':contract-config'},0))`);
}
export async function saveSettings(tx: Tx, ctx: ContractContext, raw: unknown) {
  const input = parse(settingsSchema, raw);
  await lockContractConfig(tx, ctx.tenantId);
  const before = await settings(tx, ctx.tenantId);
  revision(ctx.expectedRevision, before.revision);
  for (const key of ['postExitTypeIds', 'renewalTypeIds', 'indefiniteTypeIds'] as const) {
    await verifyIds(tx, ctx.tenantId, 'contract_types', input[key] ?? []);
  }
  const after = { ...before, ...input, revision: before.revision + 1 };
  await tx.insert(contractSettings).values(after).onConflictDoUpdate({ target: contractSettings.tenantId, set: after });
  await audit(tx, ctx, 'contract.settings.update', ctx.tenantId, before, after);
  return after;
}
export async function rules(tx: Tx, tenantId: string) {
  const headers = await tx
    .select()
    .from(contractRenewalRules)
    .where(eq(contractRenewalRules.tenantId, tenantId))
    .limit(201);
  const details = await tx
    .select()
    .from(contractRenewalDetails)
    .where(eq(contractRenewalDetails.tenantId, tenantId))
    .limit(20001);
  if (headers.length > 200 || details.length > 20000) {
    throw new AppError('PAYLOAD_TOO_LARGE', '合同续签规则超过单次处理上限');
  }
  return headers.map((h) => ({ ...h, details: details.filter((d) => d.ruleId === h.id) }));
}
export async function saveRule(tx: Tx, ctx: ContractContext, raw: unknown, id?: string) {
  const input = parse(ruleSchema, raw);
  await lockContractConfig(tx, ctx.tenantId);
  const existing = await rules(tx, ctx.tenantId);
  if (!id && existing.length >= 200) throw new AppError('PAYLOAD_TOO_LARGE', '最多配置 200 条合同续签规则');
  const before = id ? existing.find((r) => r.id === id) : null;
  if (id && !before) throw new AppError('NOT_FOUND', '续签规则不存在');
  revision(ctx.expectedRevision, before?.revision ?? 0);
  if (new Set(input.details.map((d) => d.typeId)).size !== input.details.length) {
    throw new AppError('VALIDATION_FAILED', '同规则内合同类型不能重复');
  }
  await verifyIds(tx, ctx.tenantId, 'org_objects', input.orgIds);
  await verifyIds(tx, ctx.tenantId, 'employment_employees', input.personIds);
  for (const detail of input.details) {
    await verifyIds(tx, ctx.tenantId, 'contract_types', [detail.typeId, ...detail.skipTypeIds]);
    const member = await isActiveAccount(tx, ctx.tenantId, detail.initiatorId);
    if (!member) throw new AppError('VALIDATION_FAILED', '自动续签发起人必须为有效租户成员');
  }
  const { details, ...header } = input;
  const [saved] = id
    ? await tx
        .update(contractRenewalRules)
        .set({ ...header, revision: ctx.expectedRevision + 1 })
        .where(and(eq(contractRenewalRules.tenantId, ctx.tenantId), eq(contractRenewalRules.id, id)))
        .returning()
    : await tx
        .insert(contractRenewalRules)
        .values({ ...header, tenantId: ctx.tenantId })
        .returning();
  await tx
    .delete(contractRenewalDetails)
    .where(and(eq(contractRenewalDetails.tenantId, ctx.tenantId), eq(contractRenewalDetails.ruleId, saved!.id)));
  await tx
    .insert(contractRenewalDetails)
    .values(details.map((d) => ({ ...d, tenantId: ctx.tenantId, ruleId: saved!.id })));
  const after = { ...saved!, details };
  await audit(tx, ctx, 'contract.rule.save', saved!.id, before, after);
  return after;
}
export async function saveMaster(tx: Tx, ctx: ContractContext, kind: 'types' | 'companies', raw: unknown, id?: string) {
  if (ctx.scope && !ctx.scope.all) throw new AppError('FORBIDDEN', '主数据无组织范围字段，须显式授予全部范围');
  const { z } = await import('zod');
  const input = parse(
    z.strictObject({
      code: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(200),
      enabled: z.boolean().default(true),
    }),
    raw,
  );
  const table = kind === 'types' ? contractTypes : contractCompanies;
  await lockContractConfig(tx, ctx.tenantId);
  const [before] = id
    ? await tx
        .select()
        .from(table)
        .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)))
    : [];
  if (id && !before) throw new AppError('NOT_FOUND', '主数据不存在');
  revision(ctx.expectedRevision, before?.revision ?? 0);
  const [after] = id
    ? await tx
        .update(table)
        .set({ ...input, revision: ctx.expectedRevision + 1 })
        .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)))
        .returning()
    : await tx
        .insert(table)
        .values({ ...input, tenantId: ctx.tenantId })
        .returning();
  await audit(tx, ctx, `contract.${kind}.save`, after!.id, before ?? null, after);
  return after!;
}
