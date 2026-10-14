import { isUuid, sql, type Tx } from '@italent/db';
import { decide, buttonResource, resolveObjectPermission, type SuccessionLevelRules } from '@italent/domain';
import { evaluateRisk, RiskFailure, type RiskLevel } from '@italent/domain';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { scopeAllows } from '../permission/module-access.js';
import { loadJobObject } from '../job/read-model.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { CalcBlocked, CalcObjectFailure, type CalcHandler } from './calc-contract.js';
import { codeOf } from './access.js';
import { rowsOf } from './read-sql.js';
import { lockRisk, storeRisk } from './risk-store.js';
import { riskPeople, type RiskPartTimeReader } from './risk-people.js';
async function riskPrincipal(tx: Tx, tenantId: string) {
  const userId = (await readEffectiveSetting(tx, tenantId, 'succession.system_principal_user_id')).value;
  if (typeof userId !== 'string' || !isUuid(userId)) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const [state] = rowsOf<{ ok: boolean; today: string; timezone: string }>(
    await tx.execute(sql`SELECT
    succession_calc_user_active(${tenantId}::uuid,${userId}::uuid) AND EXISTS (
      SELECT 1 FROM permission_grants g JOIN permission_profiles p ON p.tenant_id=g.tenant_id AND p.id=g.profile_id
      WHERE g.tenant_id=${tenantId}::uuid AND g.user_id=${userId}::uuid AND g.status='active'
      AND p.code='standard_succession_runner') AS ok,succession_tenant_today(${tenantId}::uuid)::text AS today,
      current_tenant_timezone() AS timezone`),
  );
  if (!state?.ok) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const object = codeOf('riskResult');
  const subject = await loadSubject(tx, userId, object, { tenantId, userId, asOf: state.today });
  const effective = resolveObjectPermission(object, subject.objectPermissions, objectCatalog)?.effective;
  if (
    !decide(subject, { action: 'object.update', resource: object, fields: ['levelId'] }, objectCatalog) ||
    !decide(
      subject,
      { action: 'object.button', resource: buttonResource(object, 'assign', 'detail') },
      objectCatalog,
    ) ||
    !effective?.editableFields.has('levelId')
  )
    throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const scope = await resolveDataScope(tx, {
    tenantId,
    userId,
    appCode: 'SuccessionAndDevelopment',
    objectCode: object,
    asOf: state.today,
  });
  if (!scope.hasDataPermission) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  return { userId, scope, today: state.today, timezone: state.timezone };
}
async function riskLevels(tx: Tx, tenantId: string): Promise<RiskLevel[]> {
  const levels = rowsOf<RiskLevel & { expression: string; rows: Record<string, unknown>[] }>(
    await tx.execute(sql`
    SELECT l.id,l.condition_expression AS expression,l.compiled_formula AS formula,
      l.compiler_version AS "compilerVersion",
      l.compile_error AS "compileError",COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY row_no)
        FROM succession_risk_level_rows r WHERE r.tenant_id=l.tenant_id AND r.level_id=l.id),'[]'::jsonb) AS rows
    FROM succession_risk_levels l WHERE l.tenant_id=${tenantId}::uuid
      AND l.enabled AND l.condition_expression IS NOT NULL
    ORDER BY l.display_order,l.id`),
  );
  return levels.map((l) => ({
    ...l,
    rules: {
      expression: l.expression,
      rows: l.rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
        ),
      ) as unknown as SuccessionLevelRules['rows'],
    },
  }));
}
export function createRiskHandler(partTimeReader?: RiskPartTimeReader): CalcHandler {
  return {
    kind: 'position_risk',
    objectType: 'position',
    authorizePage: async ({ tx, run }) => (await riskPrincipal(tx, run.tenantId)).userId,
    async execute({ tx, run, now }, object) {
      const before = await lockRisk(tx, run.tenantId, object.objectId);
      const principal = await riskPrincipal(tx, run.tenantId);
      const current = await loadJobObject(tx, run.tenantId, 'positions', object.objectId, principal.today, true);
      if (!current || !scopeAllows(principal.scope, { orgId: current.orgId }))
        throw new CalcObjectFailure('PRINCIPAL_SCOPE_MISSING', true);
      const position = await loadJobObject(tx, run.tenantId, 'positions', object.objectId, run.businessDate);
      if (!position?.isKey) throw new CalcObjectFailure('TARGET_NOT_KEY_POSITION', false);
      if (before?.method === 'manual') return 'manual_kept';
      const levels = await riskLevels(tx, run.tenantId);
      const fields = [
        ...new Set(levels.flatMap((l) => l.rules.rows.flatMap((r) => (r.fieldCode ? [r.fieldCode] : [])))),
      ];
      const people = await riskPeople(
        tx,
        {
          ...principal,
          tenantId: run.tenantId,
          positionId: object.objectId,
          asOf: run.businessDate,
          partTime: (await readEffectiveSetting(tx, run.tenantId, 'succession.part_time_in_risk_calc')).value === true,
        },
        fields,
        partTimeReader,
      );
      let levelId: string | null;
      try {
        levelId = evaluateRisk(levels, people, { today: run.businessDate, timeZone: principal.timezone });
      } catch (error) {
        if (error instanceof RiskFailure) {
          if (error.code === 'RULE_CACHE_STALE') throw new CalcBlocked('RULE_CACHE_STALE');
          throw new CalcObjectFailure(error.code, true, error.levelId, error.rowNo);
        }
        throw error;
      }
      if (before && before.levelId === levelId) return 'unchanged';
      await storeRisk(
        tx,
        {
          tenantId: run.tenantId,
          positionId: object.objectId,
          orgId: current.orgId!,
          levelId,
          method: 'computed',
          runId: run.id,
          userId: principal.userId,
          commandId: `risk:${run.id}:${object.objectId}`,
          now,
        },
        before,
      );
      return 'written';
    },
  };
}
export const riskHandler = createRiskHandler();
