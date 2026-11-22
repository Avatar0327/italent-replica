import {
  and,
  asc,
  contractCompanies,
  eq,
  inArray,
  permissionProfiles,
  sql,
  onboardingPreparationItems as items,
  onboardingPreparationRules as rules,
  onboardingPreparationRuleAssignees as selectors,
  onboardingPreparationScopeOrgs as roots,
  type PreparationSelector,
  type Tx,
} from '@italent/db';
import { type SQL } from 'drizzle-orm';
import { tenantLocalDate } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { isActiveAccount } from '../approval/resolver.js';
import { assertRevision } from '../employment/context.js';
import { loadJobObject } from '../job/read-model.js';
import type { BusinessContext } from '../job/context.js';
import type { ModuleScope } from '../permission/module-access.js';
import {
  preparationItemBody,
  preparationRuleBody,
  validatePreparationItem,
  validatePreparationRule,
  type RuleInput,
} from './preparation-config-input.js';
import { preparationConfigMissing, preparationRuleScope } from './preparation-config-scope.js';

export type PreparationConfigKind = 'preparationItems' | 'preparationRules';
type Head = typeof items.$inferSelect | typeof rules.$inferSelect;
export interface PreparationWriteScope {
  target(id: string): Promise<Head>;
  orgs(orgIds: string[]): Promise<void>;
  positionOrg(orgId: string): Promise<boolean>;
}
const tableFor = (kind: PreparationConfigKind) => (kind === 'preparationItems' ? items : rules);
const identity = (table: typeof items | typeof rules, tenantId: string, id: string) =>
  and(eq(table.tenantId, tenantId), eq(table.id, id));

export async function lockPreparationConfig(tx: Tx, tenantId: string, mode: 'read' | 'write') {
  const lock = mode === 'read' ? sql`pg_advisory_xact_lock_shared` : sql`pg_advisory_xact_lock`;
  await tx.execute(sql`SELECT ${lock}(hashtextextended(${`onboarding:preparation:${tenantId.toLowerCase()}`}, 0))`);
}

export async function preparationRuleChildren(tx: Tx, tenantId: string, ruleId: string) {
  const orgs = await tx
    .select({ id: roots.orgId })
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.ruleId, ruleId)))
    .orderBy(asc(roots.orgId));
  const users = await tx
    .select()
    .from(selectors)
    .where(and(eq(selectors.tenantId, tenantId), eq(selectors.ruleId, ruleId)))
    .orderBy(asc(selectors.ordinal));
  const assignees = users.map(({ kind, userId, positionId, postId, profileId }): PreparationSelector => {
    if (kind === 'member') return { kind, id: userId! };
    if (kind === 'position') return { kind, id: positionId! };
    if (kind === 'post') return { kind, id: postId! };
    if (kind === 'identity') return { kind, id: profileId! };
    return { kind };
  });
  return { orgIds: orgs.map(({ id }) => id), assignees };
}

async function detail(tx: Tx, row: Head) {
  const { tenantId, createdBy: _creator, updatedBy: _updater, ...dto } = row;
  return 'itemId' in dto ? { ...dto, ...(await preparationRuleChildren(tx, tenantId, row.id)) } : dto;
}

export async function readPreparationConfig(
  tx: Tx,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
  page: { limit: number; offset: number },
  id?: string,
  ruleVisibility?: SQL,
) {
  if (kind === 'preparationRules' && !ruleVisibility) preparationConfigMissing();
  const table = tableFor(kind);
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.tenantId, ctx.tenantId),
        eq(table.archived, false),
        id ? eq(table.id, id) : undefined,
        ruleVisibility,
      ),
    )
    .orderBy(asc(table.createdAt), asc(table.id))
    .limit(id ? 1 : page.limit)
    .offset(id ? 0 : page.offset);
  if (id) return rows[0] ? detail(tx, rows[0]) : preparationConfigMissing();
  return { items: await Promise.all(rows.map((row) => detail(tx, row))) };
}

export async function requirePreparationTarget(
  tx: Tx,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
  scope: ModuleScope,
  id: string,
) {
  const table = tableFor(kind);
  const [row] = await tx
    .select()
    .from(table)
    .where(
      and(
        identity(table, ctx.tenantId, id),
        kind === 'preparationRules' ? preparationRuleScope(ctx, scope, sql`${rules.id}`) : undefined,
      ),
    );
  if (!row) return preparationConfigMissing();
  if (kind === 'preparationItems') {
    const [outside] = await tx
      .select({ id: rules.id })
      .from(rules)
      .where(
        and(
          eq(rules.tenantId, ctx.tenantId),
          eq(rules.itemId, id),
          eq(rules.archived, false),
          sql`NOT ${preparationRuleScope(ctx, scope, sql`${rules.id}`)}`,
        ),
      )
      .limit(1);
    if (outside) return preparationConfigMissing();
  }
  return row;
}

async function validateRefs(tx: Tx, ctx: BusinessContext, scope: PreparationWriteScope, input: RuleInput) {
  const { tenantId } = ctx;
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const companyIds = [
    ...new Set(
      input.conditions.items
        .filter(({ field }) => field === 'contract.companyId')
        .flatMap(({ value }) => (value === null ? [] : value)),
    ),
  ];
  if (companyIds.length) {
    const found = await tx
      .select({ id: contractCompanies.id })
      .from(contractCompanies)
      .where(and(eq(contractCompanies.tenantId, tenantId), inArray(contractCompanies.id, companyIds)));
    if (found.length !== companyIds.length) preparationConfigMissing();
  }
  for (const selector of input.assignees) {
    if (!('id' in selector)) continue;
    const { kind, id } = selector;
    if (kind === 'member') {
      if (!(await isActiveAccount(tx, tenantId, id))) preparationConfigMissing();
      continue;
    }
    if (kind === 'position' || kind === 'post') {
      const ref = await loadJobObject(tx, tenantId, kind === 'position' ? 'positions' : 'posts', id, today);
      if (!ref || (kind === 'position' && (!ref.orgId || !(await scope.positionOrg(ref.orgId)))))
        preparationConfigMissing();
      continue;
    }
    const table = permissionProfiles;
    const [ref] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    if (!ref) preparationConfigMissing();
  }
}

async function saveRuleChildren(tx: Tx, tenantId: string, ruleId: string, input: RuleInput) {
  await tx.delete(roots).where(and(eq(roots.tenantId, tenantId), eq(roots.ruleId, ruleId)));
  await tx.insert(roots).values(input.orgIds.map((orgId) => ({ tenantId, ruleId, orgId })));
  await tx.delete(selectors).where(and(eq(selectors.tenantId, tenantId), eq(selectors.ruleId, ruleId)));
  await tx.insert(selectors).values(
    input.assignees.map((selector, ordinal) => ({
      tenantId,
      ruleId,
      ordinal,
      kind: selector.kind,
      userId: selector.kind === 'member' ? selector.id : null,
      positionId: selector.kind === 'position' ? selector.id : null,
      postId: selector.kind === 'post' ? selector.id : null,
      profileId: selector.kind === 'identity' ? selector.id : null,
    })),
  );
}

export async function writePreparationConfig(
  tx: Tx,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
  patch: object | null,
  previous?: Head,
  scope?: PreparationWriteScope,
) {
  if (previous?.archived) preparationConfigMissing();
  assertRevision(ctx.expectedRevision, previous?.revision ?? 0);
  const before = previous ? await detail(tx, previous) : null;
  const base = { revision: ctx.expectedRevision + 1, updatedAt: ctx.now, updatedBy: ctx.userId };
  const created = { tenantId: ctx.tenantId, createdAt: ctx.now, createdBy: ctx.userId };
  const merged = { ...before, ...patch };
  const id = previous?.id;
  let saved: Head;
  if (patch === null) {
    const table = tableFor(kind);
    if (kind === 'preparationItems') await requireUnusedItem(tx, ctx.tenantId, id!);
    [saved] = (await tx
      .update(table)
      .set({ ...base, archived: true, enabled: false })
      .where(identity(table, ctx.tenantId, id!))
      .returning()) as [Head];
  } else if (kind === 'preparationItems') {
    const input = preparationItemBody.strip().parse(merged);
    validatePreparationItem(input);
    if (id && !input.enabled) await requireUnusedItem(tx, ctx.tenantId, id);
    const itemKey = and(
      eq(items.tenantId, ctx.tenantId),
      eq(items.category, input.category),
      eq(items.code, input.code),
    );
    const [existing] = await tx.select({ id: items.id }).from(items).where(itemKey);
    if (existing && existing.id !== id) throw new AppError('CONFLICT', '同类别已经存在相同编码的准备事项');
    const changes = { ...input, ...base };
    const [row] = id
      ? await tx
          .update(items)
          .set(changes)
          .where(identity(items, ctx.tenantId, id))
          .returning()
      : await tx
          .insert(items)
          .values({ ...changes, ...created })
          .returning();
    saved = row!;
  } else {
    const input = validatePreparationRule(preparationRuleBody.strip().parse(merged));
    const { assignees: _assignees, orgIds, ...body } = input;
    if (!scope) return preparationConfigMissing();
    await scope.orgs(orgIds);
    const [item] = await tx
      .select()
      .from(items)
      .where(identity(items, ctx.tenantId, input.itemId));
    if (!item || (input.enabled && !item.enabled)) preparationConfigMissing();
    await validateRefs(tx, ctx, scope, input);
    const changes = { ...body, ...base };
    const [row] = id
      ? await tx
          .update(rules)
          .set(changes)
          .where(identity(rules, ctx.tenantId, id))
          .returning()
      : await tx
          .insert(rules)
          .values({ ...changes, ...created })
          .returning();
    saved = row!;
    await saveRuleChildren(tx, ctx.tenantId, saved.id, input);
  }
  const action = patch === null ? 'archive' : id ? 'update' : 'create';
  await recordPreparationConfigChange(tx, ctx, kind, action, before, saved);
  return { id: saved.id, revision: saved.revision, status: saved.archived ? 'archived' : 'saved' };
}

async function recordPreparationConfigChange(
  tx: Tx,
  ctx: BusinessContext,
  kind: PreparationConfigKind,
  action: 'create' | 'update' | 'archive',
  before: Awaited<ReturnType<typeof detail>> | null,
  saved: Head,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.${kind}.${action}`,
    // 默认拒绝通用审计详情，规则需具备当前多组织范围定位器才可披露。
    objectType: 'onboarding-preparation-config',
    objectId: saved.id,
    before,
    after: await detail(tx, saved),
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
}

async function requireUnusedItem(tx: Tx, tenantId: string, itemId: string) {
  const [active] = await tx
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.tenantId, tenantId), eq(rules.itemId, itemId), eq(rules.enabled, true)))
    .limit(1);
  if (active) throw new AppError('CONFLICT', '准备事项仍被启用规则引用');
}
