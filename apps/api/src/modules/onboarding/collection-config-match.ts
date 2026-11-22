import {
  and,
  asc,
  eq,
  inArray,
  onboardingCollectionRules as rules,
  onboardingCollectionScopeOrgs as scopeOrgs,
  onboardingCollectionTemplates as templates,
  sql,
  type Tx,
} from '@italent/db';
import { ENTRY_STATUS, evaluateCondition, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { adminAncestors } from '../approval/resolver.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import { entryCaseContext } from '../employment/entry-case.js';
import { loadPendingContract } from '../employment/entry-pending-contract.js';
import { entryLifecyclePort, type EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import type { EmploymentContext } from '../employment/types.js';
import { employeeSnapshot } from '../personnel/employee-write.js';
import { loadCollectionSettings, lockCollectionConfig, ruleSubsets, templateFields } from './collection-config.js';

const skipped = (reason: 'COLLECTION_AUTO_DISABLED' | 'COLLECTION_RULE_NOT_MATCHED') =>
  ({ status: 'skipped', reason }) as const;

function missing(mode: 'auto' | 'manual') {
  if (mode === 'auto') return skipped('COLLECTION_RULE_NOT_MATCHED');
  throw new AppError('CONFLICT', '当前待入职未匹配采集规则', { reason: 'COLLECTION_RULE_NOT_MATCHED' });
}

/** R2-T01 §4.1。可信调用方先完成动作授权，此端口只读现版本和配置，不产生任务。 */
export async function matchEntryCollection(
  tx: Tx,
  ctx: EmploymentContext,
  ref: EntryCaseWriteRef,
  mode: 'auto' | 'manual',
) {
  const { record } = await lockPendingEntry(tx, { ...ctx, expectedRevision: ref.businessRevision }, ref.businessId);
  await entryLifecyclePort().lockForWrite(tx, entryCaseContext(ctx), ref, ['pending']);
  if (record.entryStatus === ENTRY_STATUS.cancelled)
    throw new AppError('CONFLICT', '已取消的待入职不能匹配采集配置', { reason: 'ENTRY_CANCELLED' });
  await lockCollectionConfig(tx, ctx.tenantId, 'read');
  if (mode === 'auto' && !(await loadCollectionSettings(tx, ctx.tenantId)).enabled)
    return skipped('COLLECTION_AUTO_DISABLED');
  if (!record.fields.departmentId) return missing(mode);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const orgChain = await adminAncestors(tx, ctx.tenantId, today, record.fields.departmentId);
  const person = await employeeSnapshot(tx, ctx, record.employeeId);
  const contract = await loadPendingContract(tx, ctx, record.id);
  const values = {
    'employee.gender': person?.gender,
    'employee.idType': person?.idType,
    'record.employType': record.fields.employType,
    'record.changeType': record.changeType,
    'contract.companyId': contract?.companyId,
  };
  const candidates = await tx
    .select({ rule: rules, template: templates })
    .from(rules)
    .innerJoin(
      templates,
      and(
        eq(templates.tenantId, rules.tenantId),
        eq(templates.id, rules.templateId),
        eq(templates.enabled, true),
        eq(templates.archived, false),
      ),
    )
    .where(
      and(
        eq(rules.tenantId, ctx.tenantId),
        eq(rules.enabled, true),
        eq(rules.archived, false),
        sql`EXISTS (SELECT 1 FROM ${scopeOrgs} WHERE ${scopeOrgs.tenantId} = ${rules.tenantId}
        AND ${scopeOrgs.ruleId} = ${rules.id} AND ${inArray(scopeOrgs.orgId, orgChain)})`,
      ),
    )
    .orderBy(asc(rules.priority), asc(rules.id));
  const hits = candidates.filter(({ rule }) => evaluateCondition(rule.conditions, { values, orgAncestors: {} }).result);
  const [hit, next] = hits;
  if (!hit) return missing(mode);
  if (hit.rule.priority === next?.rule.priority)
    throw new AppError('CONFLICT', '同优先级匹配到多条采集规则', { reason: 'COLLECTION_RULE_AMBIGUOUS' });
  return {
    status: 'matched' as const,
    ...hit,
    fields: await templateFields(tx, ctx.tenantId, hit.template.id),
    requiredSubsets: await ruleSubsets(tx, ctx.tenantId, hit.rule.id),
  };
}
