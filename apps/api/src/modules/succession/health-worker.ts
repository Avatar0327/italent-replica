import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { RULE_COMPILER_VERSION, evaluateHealthLevels } from '@italent/domain';
import { lockOrganizationSettings } from '../org/locks.js';
import { scopeAllows } from '../permission/module-access.js';
import { CalcBlocked, CalcObjectFailure, type CalcHandler } from './calc-contract.js';
import { healthPrincipal } from './health-principal.js';
import { healthMetricReader, type HealthReads } from './health-metrics.js';
import { lockHealthTarget, requireHealthOrg, storeHealth } from './health-results.js';
import { unsupportedHealthRule } from './health-rule-support.js';
import { levelViews } from './levels-store.js';
import { rowsOf } from './read-sql.js';
import { successionReviewReads } from './ports.js';
import type { CalcProducer } from './calc-jobs.js';
export function createHealthHandler(kind: 'org_health' | 'org_health_reset', port?: HealthReads): CalcHandler {
  const reset = kind === 'org_health_reset';
  return {
    kind,
    objectType: 'org',
    authorizePage: async ({ tx, run }) => (await healthPrincipal(tx, run.tenantId, reset)).userId,
    async execute(ctx, object) {
      const { tx, run, now } = ctx;
      await lockOrganizationSettings(tx, run.tenantId);
      await tx.execute(sql`SELECT kind FROM succession_rule_settings WHERE tenant_id=${run.tenantId}::uuid
        AND kind='org_health' FOR SHARE`);
      const before = await lockHealthTarget(tx, run.tenantId, object.objectId);
      const principal = await healthPrincipal(tx, run.tenantId, reset);
      if (!scopeAllows(principal.scope, { orgId: object.objectId }))
        throw new CalcObjectFailure('PRINCIPAL_SCOPE_MISSING', true);
      try {
        await requireHealthOrg(tx, run.tenantId, object.objectId, run.businessDate, principal.scope);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
        throw new CalcObjectFailure('TARGET_NOT_ACTIVE', false);
      }
      if (reset && (before?.revision ?? 0) !== object.expectedRevision)
        throw new CalcObjectFailure('REVISION_CONFLICT', false);
      if (!reset && before?.method === 'manual') return 'manual_kept';
      const levels = await healthLevels(tx, run.tenantId);
      // DEC-460：执行前拒绝存量禁用配置，不能被未引用行或更早命中等级掩盖。
      for (const level of levels) {
        const unsupported = level.rules?.rows.find(unsupportedHealthRule);
        if (unsupported) throw new CalcObjectFailure('FIELD_FORBIDDEN', true, level.id, unsupported.rowNo);
      }
      const read = healthMetricReader(ctx, object, principal, port ?? successionReviewReads(run.tenantId));
      const result = await evaluateHealthLevels(
        levels.map((l) => ({ ...l, displayOrder: Number(l.displayOrder) })),
        async (row, levelId) => {
          try {
            return await read(row);
          } catch (error) {
            if (!(error instanceof CalcObjectFailure)) throw error;
            throw new CalcObjectFailure(error.code, error.retryable, levelId, error.rowNo ?? row.rowNo);
          }
        },
        { today: run.businessDate, timeZone: principal.timezone },
      );
      if (result.failure?.code === 'RULE_CACHE_STALE') throw new CalcBlocked('RULE_CACHE_STALE');
      if (result.failure)
        throw new CalcObjectFailure(
          result.failure.code,
          true,
          result.failure.levelId,
          'rowNo' in result.failure ? result.failure.rowNo : undefined,
        );
      await storeHealth(
        tx,
        {
          tenantId: run.tenantId,
          userId: principal.userId,
          timezone: principal.timezone,
          now,
          expectedRevision: before?.revision ?? 0,
          commandId: `health:${run.id}:${object.objectId}`,
        },
        object.objectId,
        result.levelId,
        'computed',
        before,
        (before?.revision ?? 0) + 1,
        run.id,
      );
      return 'written';
    },
  };
}
/** DEC-448：runTenant 不生产日期槽任务，只让 B3b prepare 取已冻结的 pending / running 集合。 */
export const healthProducers: readonly CalcProducer[] = (['org_health', 'org_health_reset'] as const).map((kind) => ({
  kind,
  runTenant: async () => undefined,
}));

async function healthLevels(tx: Tx, tenantId: string) {
  const stored = rowsOf<{
    id: string;
    compiler_version: string | null;
    compile_error: unknown;
    condition_expression: string | null;
  }>(
    await tx.execute(
      sql`SELECT * FROM succession_health_levels WHERE tenant_id=${tenantId}::uuid AND enabled
        ORDER BY display_order,id`,
    ),
  );
  if (
    stored.some(
      (l) => l.condition_expression !== null && (l.compiler_version !== RULE_COMPILER_VERSION || l.compile_error),
    )
  )
    throw new CalcBlocked('RULE_CACHE_STALE');
  return levelViews(
    tx,
    tenantId,
    'health',
    stored.map((l) => l.id),
  );
}
