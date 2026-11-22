import {
  and,
  asc,
  contractCompanies,
  eq,
  inArray,
  onboardingCollectionFields as fields,
  onboardingCollectionRequiredSubsets as subsets,
  onboardingCollectionRules as rules,
  onboardingCollectionScopeOrgs as scopeOrgs,
  onboardingCollectionSettings as settings,
  onboardingCollectionTemplates as templates,
  sql,
  type Tx,
} from '@italent/db';
import { not } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { assertRevision } from '../employment/context.js';
import { type BusinessContext } from '../job/context.js';
import type { ModuleScope } from '../permission/module-access.js';
import {
  ruleBody,
  templateBody,
  validateRequiredSubsets,
  validateRule,
  validateTemplate,
  type RuleInput,
  type TemplateInput,
} from './collection-config-input.js';
import { configMissing, requireCollectionOrgScope, ruleScopeSql } from './collection-config-scope.js';

export type CollectionConfigKind = 'collectionTemplates' | 'collectionRules' | 'collectionSettings';
type ConfigHead = typeof templates.$inferSelect | typeof rules.$inferSelect;
type ConfigScope = { ctx: BusinessContext; scope: ModuleScope };

const headOf = (kind: CollectionConfigKind) => (kind === 'collectionTemplates' ? templates : rules);
const identity = (tenantId: string, id: string, table: typeof templates | typeof rules) =>
  and(eq(table.tenantId, tenantId), eq(table.id, id));

/** 规则范围及其模板都在同一租户配置锁下检查和保存。人员匹配可按同序取得共享锁。 */
export async function lockCollectionConfig(tx: Tx, tenantId: string, mode: 'write' | 'read') {
  const lock = mode === 'write' ? sql`pg_advisory_xact_lock` : sql`pg_advisory_xact_lock_shared`;
  await tx.execute(sql`SELECT ${lock}(hashtextextended(${`onboarding:collection:${tenantId}`}, 0))`);
}

export async function templateFields(tx: Tx, tenantId: string, templateId: string) {
  return tx
    .select({
      objectCode: fields.objectCode,
      fieldCode: fields.fieldCode,
      group: fields.group,
      editable: fields.editable,
      required: fields.required,
    })
    .from(fields)
    .where(and(eq(fields.tenantId, tenantId), eq(fields.templateId, templateId)))
    .orderBy(asc(fields.position));
}

export async function ruleSubsets(tx: Tx, tenantId: string, ruleId: string) {
  const rows = await tx
    .select({ code: subsets.subsetCode })
    .from(subsets)
    .where(and(eq(subsets.tenantId, tenantId), eq(subsets.ruleId, ruleId)))
    .orderBy(asc(subsets.subsetCode));
  return rows.map((row) => row.code);
}

async function detail(tx: Tx, row: ConfigHead) {
  const { tenantId, archived: _archived, createdBy: _createdBy, updatedBy: _updatedBy, ...dto } = row;
  if ('templateId' in dto) {
    const orgs = await tx
      .select({ id: scopeOrgs.orgId })
      .from(scopeOrgs)
      .where(and(eq(scopeOrgs.tenantId, tenantId), eq(scopeOrgs.ruleId, row.id)))
      .orderBy(asc(scopeOrgs.orgId));
    return { ...dto, orgIds: orgs.map((org) => org.id), requiredSubsets: await ruleSubsets(tx, tenantId, row.id) };
  }
  return { ...dto, fields: await templateFields(tx, tenantId, row.id) };
}

export async function readCollectionConfig(
  tx: Tx,
  { ctx, scope }: ConfigScope,
  kind: CollectionConfigKind,
  query: { limit: number; offset: number },
  id?: string,
) {
  if (kind === 'collectionSettings') return loadCollectionSettings(tx, ctx.tenantId);
  const table = headOf(kind);
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.tenantId, ctx.tenantId),
        eq(table.archived, false),
        id ? eq(table.id, id) : undefined,
        kind === 'collectionRules' ? ruleScopeSql(ctx, scope, sql`${table.id}`) : undefined,
      ),
    )
    .orderBy(asc(table.id))
    .limit(id ? 1 : query.limit)
    .offset(id ? 0 : query.offset);
  if (id) return rows[0] ? detail(tx, rows[0]) : configMissing();
  return { items: await Promise.all(rows.map((row) => detail(tx, row))) };
}

/** 读包括已归档行的定位信息，以便旧命令重放时继续按当前组织范围校验。 */
export async function requireCollectionTarget(
  tx: Tx,
  { ctx, scope }: ConfigScope,
  kind: CollectionConfigKind,
  id: string,
) {
  if (kind === 'collectionSettings') return;
  const table = headOf(kind);
  const [row] = await tx
    .select()
    .from(table)
    .where(
      and(
        identity(ctx.tenantId, id, table),
        kind === 'collectionRules' ? ruleScopeSql(ctx, scope, sql`${table.id}`) : undefined,
      ),
    );
  if (!row) return configMissing();
  if (kind === 'collectionTemplates') {
    const [outside] = await tx
      .select({ id: rules.id })
      .from(rules)
      .where(
        and(
          eq(rules.tenantId, ctx.tenantId),
          eq(rules.templateId, id),
          eq(rules.archived, false),
          not(ruleScopeSql(ctx, scope, sql`${rules.id}`)),
        ),
      )
      .limit(1);
    if (outside) return configMissing();
  }
  return row;
}

export async function loadCollectionSettings(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ enabled: settings.enabled, revision: settings.revision })
    .from(settings)
    .where(eq(settings.tenantId, tenantId));
  return row ?? { enabled: true, revision: 0 };
}

async function auditConfig(
  tx: Tx,
  ctx: BusinessContext,
  kind: CollectionConfigKind,
  id: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.${kind}.${action}`,
    // 通用任职配置日志按租户可见，无法表达规则的多组织范围。独立类型沿审计读取默认拒绝。
    objectType: 'onboarding-collection-config',
    objectId: id,
    before,
    after,
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
}

export async function saveCollectionSettings(tx: Tx, ctx: BusinessContext, enabled: boolean) {
  const before = await loadCollectionSettings(tx, ctx.tenantId);
  assertRevision(ctx.expectedRevision, before.revision);
  const after = { enabled, revision: before.revision + 1 };
  const changes = { ...after, updatedAt: ctx.now, updatedBy: ctx.userId };
  await tx
    .insert(settings)
    .values({ ...changes, tenantId: ctx.tenantId, createdAt: ctx.now, createdBy: ctx.userId })
    .onConflictDoUpdate({ target: settings.tenantId, set: changes });
  await auditConfig(tx, ctx, 'collectionSettings', ctx.tenantId, 'update', before, after);
  return { id: ctx.tenantId, revision: after.revision, status: 'saved' };
}

async function saveTemplate(tx: Tx, ctx: BusinessContext, input: TemplateInput, previous?: ConfigHead) {
  const { fields: children, ...body } = input;
  const changes = { ...body, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now };
  if (previous) {
    const attached = await tx
      .select({ id: rules.id })
      .from(rules)
      .where(and(eq(rules.tenantId, ctx.tenantId), eq(rules.templateId, previous.id), eq(rules.archived, false)));
    for (const { id } of attached)
      validateRequiredSubsets({ requiredSubsets: await ruleSubsets(tx, ctx.tenantId, id) }, children);
  }
  const [row] = previous
    ? await tx
        .update(templates)
        .set(changes)
        .where(identity(ctx.tenantId, previous.id, templates))
        .returning()
    : await tx
        .insert(templates)
        .values({
          ...changes,
          tenantId: ctx.tenantId,
          createdBy: ctx.userId,
          createdAt: ctx.now,
        })
        .returning();
  const templateId = row!.id;
  await tx.delete(fields).where(and(eq(fields.tenantId, ctx.tenantId), eq(fields.templateId, templateId)));
  await tx
    .insert(fields)
    .values(children.map((field, position) => ({ ...field, tenantId: ctx.tenantId, templateId, position })));
  return row!;
}

async function saveRule(tx: Tx, { ctx, scope }: ConfigScope, input: RuleInput, previous?: ConfigHead) {
  const { orgIds, requiredSubsets, ...body } = input;
  await requireCollectionOrgScope(tx, ctx, scope, orgIds);
  const [template] = await tx
    .select({ archived: templates.archived })
    .from(templates)
    .where(identity(ctx.tenantId, body.templateId, templates));
  if (!template || template.archived) configMissing();
  validateRequiredSubsets(input, await templateFields(tx, ctx.tenantId, body.templateId));
  const changes = { ...body, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now };
  const [row] = previous
    ? await tx
        .update(rules)
        .set(changes)
        .where(identity(ctx.tenantId, previous.id, rules))
        .returning()
    : await tx
        .insert(rules)
        .values({
          ...changes,
          tenantId: ctx.tenantId,
          createdBy: ctx.userId,
          createdAt: ctx.now,
        })
        .returning();
  const ruleId = row!.id;
  await tx.delete(scopeOrgs).where(and(eq(scopeOrgs.tenantId, ctx.tenantId), eq(scopeOrgs.ruleId, ruleId)));
  await tx.insert(scopeOrgs).values(orgIds.map((orgId) => ({ tenantId: ctx.tenantId, ruleId, orgId })));
  await tx.delete(subsets).where(and(eq(subsets.tenantId, ctx.tenantId), eq(subsets.ruleId, ruleId)));
  if (requiredSubsets.length)
    await tx
      .insert(subsets)
      .values(requiredSubsets.map((subsetCode) => ({ tenantId: ctx.tenantId, ruleId, subsetCode })));
  return row!;
}

type SavedDetail = Awaited<ReturnType<typeof detail>>;
function businessFields(previous: SavedDetail | null) {
  if (!previous) return {};
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = previous;
  return body;
}

export async function writeCollectionResource(
  tx: Tx,
  access: ConfigScope,
  kind: Exclude<CollectionConfigKind, 'collectionSettings'>,
  patch: object | null,
  id?: string,
) {
  const { ctx } = access;
  const previous = id ? await requireCollectionTarget(tx, access, kind, id) : undefined;
  if (previous?.archived) configMissing();
  assertRevision(ctx.expectedRevision, previous?.revision ?? 0);
  const before = previous ? await detail(tx, previous) : null;
  const action = patch === null ? 'archive' : id ? 'update' : 'create';
  let saved: ConfigHead;
  if (patch === null) {
    const table = headOf(kind);
    const [row] = await tx
      .update(table)
      .set({
        archived: true,
        enabled: false,
        revision: ctx.expectedRevision + 1,
        updatedAt: ctx.now,
        updatedBy: ctx.userId,
      })
      .where(identity(ctx.tenantId, id!, table))
      .returning();
    saved = row!;
  } else {
    const merged = { ...businessFields(before), ...patch };
    if (kind === 'collectionTemplates') {
      const input = templateBody.parse(merged);
      validateTemplate(input);
      saved = await saveTemplate(tx, ctx, input, previous);
    } else {
      const input = ruleBody.parse(merged);
      validateRule(input);
      await validateCompanyRefs(tx, ctx.tenantId, input);
      saved = await saveRule(tx, access, input, previous);
    }
  }
  await auditConfig(tx, ctx, kind, saved.id, action, before, {
    ...(await detail(tx, saved)),
    archived: saved.archived,
  });
  return { id: saved.id, revision: saved.revision, status: saved.archived ? 'archived' : 'saved' };
}

async function validateCompanyRefs(tx: Tx, tenantId: string, input: RuleInput) {
  const ids = [
    ...new Set(
      input.conditions.items
        .filter((item) => item.field === 'contract.companyId')
        .flatMap(({ value }) => (value === null ? [] : typeof value === 'string' ? [value] : value)),
    ),
  ];
  if (!ids.length) return;
  const rows = await tx
    .select({ id: contractCompanies.id })
    .from(contractCompanies)
    .where(and(eq(contractCompanies.tenantId, tenantId), inArray(contractCompanies.id, ids)));
  if (rows.length !== ids.length) configMissing();
}
