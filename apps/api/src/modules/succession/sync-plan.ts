import { lockHealthRules } from './health-references.js';
/** §5.7 步骤 7、9～13：快照规划和全部页 0 终态；不写继任记录，不调用 recordOutcome。 */
import { sql, successionSyncItems as items, successionSyncTargets as targets, type Tx } from '@italent/db';
import type {
  OutcomeItem,
  SyncNomination,
  SyncObjectResult,
  SyncOrgHealth,
  SyncRunHeader,
  SyncTargetRegistration,
  TalentReviewSyncPort,
  SourceReadAuthorization,
  SyncErrorCode,
} from '../talent-review/sync-port.js';
import { readinessPort } from '../talent-review/readiness-port.js';
import { lockTargets } from './record-write.js';
import { rowsOf, successorStatusSql } from './read-sql.js';
import { PlanFailure, targetAt, targetKey, type PlanTarget, type writerAccess } from './sync-access.js';

type Writer = Awaited<ReturnType<typeof writerAccess>>;
export interface FrozenPlan {
  objects: SyncObjectResult[];
  nominations: SyncNomination[];
  health: readonly SyncOrgHealth[];
  denied: SourceReadAuthorization['forbidden'][];
}
export async function readPlan(
  tx: Tx,
  tenantId: string,
  runId: string,
  port: TalentReviewSyncPort,
): Promise<FrozenPlan> {
  const key = { tenantId, runId, consumer: 'succession' as const };
  const denied: FrozenPlan['denied'] = [];
  const authorize = async (page: Parameters<TalentReviewSyncPort['authorizeSourceRead']>[1]['page']) => {
    const result = await port.authorizeSourceRead(tx, { ...key, page });
    if (result.runStatus === 'superseded') throw new PlanFailure('RUN_SUPERSEDED');
    if (!result.ok) throw new PlanFailure(result.reason ?? 'SOURCE_UNAVAILABLE');
    denied.push(result.forbidden);
  };
  const objects: SyncObjectResult[] = [];
  const nominations: SyncNomination[] = [];
  let after: string | undefined;
  do {
    const page = await port.listRunObjects(tx, { ...key, limit: 500, ...(after ? { after } : {}) });
    await authorize({
      objectIds: page.items.map((o) => o.objectId),
      fieldCodes: [...new Set(page.items.flatMap((o) => Object.keys(o.fields)))],
    });
    objects.push(...page.items);
    after = page.next ?? undefined;
  } while (after);
  do {
    const page = await port.listRunNominations(tx, { ...key, limit: 2000, ...(after ? { after } : {}) });
    await authorize({
      nominationIds: page.items.map((n) => n.nominationId),
      objectIds: [...new Set(page.items.map((n) => n.objectId))],
      fieldCodes: [
        ...new Set([
          ...page.items.flatMap((n) => Object.keys(n.formValues)),
          'kind',
          'direction',
          'orgId',
          'positionId',
          'successorEmployeeId',
          'readinessId',
          'readinessCode',
          'syncEligible',
        ]),
      ],
    });
    nominations.push(...page.items);
    after = page.next ?? undefined;
  } while (after);
  const health = await port.listRunOrgHealth(tx, key);
  await authorize({ orgIds: health.map((h) => h.orgId), fieldCodes: ['levelId', 'levelCode', 'manual'] });
  if (
    [...objects.map((o) => o.fields), ...nominations.map((n) => n.formValues)].some((fields) =>
      Object.values(fields).some((f) => f.status === 'unavailable'),
    )
  ) {
    throw new PlanFailure('SOURCE_UNAVAILABLE');
  }
  return { objects, nominations, health, denied };
}
export interface TargetPlan extends PlanTarget {
  action: SyncTargetRegistration['action'] | 'health_write';
  nominations: SyncNomination[];
  health?: SyncOrgHealth;
}
export async function collectTargets(
  tx: Tx,
  tenant: string,
  header: SyncRunHeader,
  plan: FrozenPlan,
  strategy: string,
) {
  const result = new Map<string, TargetPlan>();
  // target 方向只回执；不会作为继任写入目标。原触发人授权另包含全部快照提名目标。
  for (const n of plan.nominations.filter(
    (n) =>
      n.direction === 'successor' && plan.objects.find((o) => o.objectId === n.objectId)?.blockReason !== 'terminated',
  )) {
    const target = { kind: n.kind, id: (n.orgId ?? n.positionId)! };
    const key = targetKey(target);
    if (!result.has(key))
      result.set(key, {
        ...target,
        nominations: [],
        action: strategy === 'overwrite_in_scope' ? 'scope_overwrite' : (strategy as 'append' | 'overwrite'),
      });
    result.get(key)!.nominations.push(n);
  }
  if (strategy === 'overwrite_in_scope' && header.scopeOrgIds.length) {
    const old = rowsOf<{ kind: 'org' | 'position'; id: string }>(
      await tx.execute(sql`
      SELECT DISTINCT r.succession_type AS kind,coalesce(r.target_org_id,r.target_position_id) AS id
      FROM succession_records r LEFT JOIN LATERAL (SELECT org_id FROM job_position_versions v
        WHERE v.tenant_id=r.tenant_id AND v.object_id=r.target_position_id
          AND v.start_date<=${header.businessDate}::date
        ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1) p ON true
      WHERE r.tenant_id=${tenant}::uuid AND r.deleted_at IS NULL AND r.start_date<=${header.businessDate}::date
        AND r.end_date>${header.businessDate}::date AND coalesce(r.target_org_id,p.org_id)
        = ANY(${`{${header.scopeOrgIds.join(',')}}`}::uuid[])`),
    );
    for (const t of old)
      if (!result.has(targetKey(t))) result.set(targetKey(t), { ...t, action: 'delete_only', nominations: [] });
  }
  for (const h of plan.health.filter((h) => h.status !== 'not_provided')) {
    const target = { kind: 'org_health' as const, id: h.orgId };
    result.set(targetKey(target), { ...target, action: 'health_write', nominations: [], health: h });
  }
  return [...result.values()].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
}
const deniedObject = (plan: FrozenPlan, object: string) => {
  for (const d of plan.denied) {
    if (d.objectIds.includes(object)) return { scope: 'object', ref: object };
    if (d.fields[object]?.length) return { scope: 'field', ref: d.fields[object]![0]! };
    const source = d.sources.find((s) => s.objectId === object);
    if (source) return { scope: 'source', ref: source.source };
  }
  return undefined;
};
interface PlanInput {
  tenantId: string;
  batchId: string;
  header: SyncRunHeader;
  plan: FrozenPlan;
  targets: TargetPlan[];
  writer: Writer;
  executionNo: number;
  pageCommandId: string;
  now: Date;
}
type Put = (
  kind: OutcomeItem['rowKind'],
  id: string,
  code?: SyncErrorCode,
  params?: Readonly<Record<string, unknown>>,
) => void;
type Outcomes = Map<string, OutcomeItem>;
async function nominationOutcomes(tx: Tx, input: PlanInput, put: Put) {
  const { tenantId, header, plan, writer } = input;
  const readiness = await readinessPort.list(tx, tenantId);
  const readyIds = new Map<string, string | null>();
  for (const n of plan.nominations) {
    const denied = deniedObject(plan, n.objectId);
    const object = plan.objects.find((o) => o.objectId === n.objectId);
    if (denied) put('nomination', n.nominationId, 'SOURCE_REVOKED', denied);
    else if (n.direction === 'target' || object?.blockReason === 'terminated')
      put('nomination', n.nominationId, undefined, {
        reason: n.direction === 'target' ? 'direction_target' : 'object_terminated',
      });
    else if (!n.syncEligible) put('nomination', n.nominationId, 'SUBJECT_IN_PROCESS');
    else {
      const active = rowsOf<{ active: boolean }>(
        await tx.execute(sql`SELECT
        (${successorStatusSql(tenantId, sql`${n.successorEmployeeId}::uuid`, header.businessDate)} IS NOT NULL
        AND ${successorStatusSql(tenantId, sql`${n.successorEmployeeId}::uuid`, writer.today)} IS NOT NULL) AS active`),
      )[0];
      const level = readiness.find((r) => (n.readinessId ? r.id === n.readinessId : r.code === n.readinessCode));
      readyIds.set(n.nominationId, level?.id ?? null);
      if (!active?.active) put('nomination', n.nominationId, 'SUCCESSOR_NOT_ACTIVE');
      else if ((n.readinessId || n.readinessCode) && !level) put('nomination', n.nominationId, 'READINESS_UNKNOWN');
      else if (level && !level.enabled) put('nomination', n.nominationId, 'READINESS_DISABLED');
    }
  }
  return readyIds;
}
async function checkTarget(tx: Tx, input: PlanInput, t: TargetPlan) {
  const { tenantId, header, plan, writer } = input;
  const state = await targetAt(tx, tenantId, t, header.businessDate);
  let code: SyncErrorCode | undefined;
  let params: Readonly<Record<string, unknown>> | undefined;
  let healthLevelId: string | null = null;
  if (t.health) {
    const denied = plan.denied.find((d) => d.orgIds.includes(t.id) || d.orgFields[t.id]?.length);
    if (t.health.status === 'forbidden' || denied) {
      code = 'SOURCE_REVOKED';
      const field = denied?.orgFields[t.id]?.[0];
      params = { scope: field ? 'field' : 'org', ref: field ?? t.id };
    } else if (t.health.status === 'value') {
      const [level] = rowsOf<{ id: string; enabled: boolean }>(
        await tx.execute(sql`
          SELECT id,enabled FROM succession_health_levels WHERE tenant_id=${tenantId}::uuid
          AND ${t.health.levelId ? sql`id=${t.health.levelId}::uuid` : sql`code=${t.health.levelCode}`} LIMIT 1`),
      );
      healthLevelId = level?.id ?? null;
      if (!level) code = 'HEALTH_LEVEL_UNKNOWN';
      else if (!level.enabled) code = 'HEALTH_LEVEL_DISABLED';
    }
  }
  if (!code) {
    if (!state || !state.current || (!t.health && !state.enabled)) code = 'TARGET_NOT_FOUND';
    else if (t.kind === 'position' && !state.is_key) code = 'TARGET_NOT_KEY_POSITION';
    else if (!(await writer.covers(t))) code = 'TARGET_OUT_OF_SCOPE';
  }
  return { code, params, healthLevelId };
}
async function targetPlans(tx: Tx, input: PlanInput, outcomes: Outcomes, put: Put) {
  const { tenantId, batchId, header, executionNo, pageCommandId } = input;
  const registrations: SyncTargetRegistration[] = [];
  const savedTargets: (typeof targets.$inferInsert)[] = [];
  for (const t of input.targets) {
    const key = targetKey(t);
    const rowKind = t.health ? 'org_health' : 'target';
    const rowId = t.health ? t.id : key;
    const checked = await checkTarget(tx, input, t);
    let { code, params } = checked;
    const { healthLevelId } = checked;
    if (code) {
      put(rowKind, rowId, code, params);
      for (const n of t.nominations)
        if (!outcomes.has(`nomination:${n.nominationId}`)) put('nomination', n.nominationId, code);
    } else if (!t.health) {
      const failed = t.nominations.filter((n) => outcomes.get(`nomination:${n.nominationId}`)?.status === 'failed');
      const planned = t.nominations.filter((n) => !outcomes.has(`nomination:${n.nominationId}`));
      if (failed.length && t.action !== 'append') {
        code = 'TARGET_PARTIAL_NOMINATIONS';
        params = { causeNominationIds: failed.map((n) => n.nominationId) };
        put('target', key, code, params);
        for (const n of planned) put('nomination', n.nominationId, code, params);
      }
    }
    if (!t.health)
      registrations.push({
        targetKey: key as SyncTargetRegistration['targetKey'],
        action: t.action as SyncTargetRegistration['action'],
        nominationIds: t.nominations.map((n) => n.nominationId),
      });
    const old = t.health
      ? []
      : rowsOf<{ id: string }>(
          await tx.execute(sql`SELECT id FROM succession_records
      WHERE tenant_id=${tenantId}::uuid AND succession_type=${t.kind}
      AND coalesce(target_org_id,target_position_id)=${t.id}::uuid AND deleted_at IS NULL
      AND start_date<=${header.businessDate}::date AND end_date>${header.businessDate}::date ORDER BY id FOR UPDATE`),
        );
    savedTargets.push({
      tenantId,
      batchId,
      targetKind: t.kind,
      targetId: t.id,
      action: t.action,
      targetRowKey: key,
      oldRecordIds: old.map((r) => r.id),
      healthLevelId,
      healthManual: t.health?.manual ?? null,
      healthStatus: t.health?.status ?? null,
      status: code ? 'failed' : 'pending',
      errorCode: code ?? null,
      errorParams: params ?? null,
      executionNo,
      pageCommandId,
    });
  }
  return { registrations, savedTargets };
}
function objectOutcomes(plan: FrozenPlan, outcomes: Outcomes, put: Put) {
  for (const h of plan.health.filter((h) => h.status === 'not_provided')) {
    put('org_health', h.orgId, undefined, { reason: 'not_provided' });
  }
  for (const o of plan.objects) {
    const denied = plan.denied.some((d) => d.objectIds.includes(o.objectId));
    const noms = plan.nominations.filter((n) => n.objectId === o.objectId);
    const rows = noms.map((n) => outcomes.get(`nomination:${n.nominationId}`));
    if (denied) put('object', o.objectId, 'SOURCE_REVOKED', { scope: 'object', ref: o.objectId });
    else if (!noms.length) put('object', o.objectId, undefined, { reason: 'no_nominations' });
    else if (rows.every(Boolean)) {
      const failed = rows.filter((r) => r?.status === 'failed');
      if (failed.length)
        put('object', o.objectId, 'NOMINATIONS_FAILED', {
          codes: [...new Set(failed.map((r) => r!.errorCode))],
          nominationIds: failed.map((r) => r!.rowId),
        });
      else put('object', o.objectId, undefined, { reason: rows[0]!.errorParams?.['reason'] ?? 'direction_target' });
    }
  }
}
export async function persistPlan(tx: Tx, input: PlanInput) {
  const { tenantId, batchId, plan, executionNo, pageCommandId, now } = input;
  if (input.targets.some((t) => t.kind === 'org_health')) await lockHealthRules(tx, tenantId);
  await lockTargets(
    tx,
    tenantId,
    input.targets.map((t) => ({
      kind: t.kind,
      id: t.id,
    })),
  );
  const outcomes = new Map<string, OutcomeItem>();
  const put = (
    rowKind: OutcomeItem['rowKind'],
    rowId: string,
    errorCode?: SyncErrorCode,
    errorParams?: Readonly<Record<string, unknown>>,
  ) => {
    const row: OutcomeItem = {
      rowKind,
      rowId,
      status: errorCode ? 'failed' : 'skipped',
      recovery: 'none',
      executionNo,
      pageCommandId,
      updatedAt: now,
      ...(errorCode ? { errorCode } : {}),
      ...(errorParams ? { errorParams } : {}),
    };
    outcomes.set(`${rowKind}:${rowId}`, row);
  };
  const readyIds = await nominationOutcomes(tx, input, put);
  const { registrations, savedTargets } = await targetPlans(tx, input, outcomes, put);
  objectOutcomes(plan, outcomes, put);
  for (const n of plan.nominations) {
    const out = outcomes.get(`nomination:${n.nominationId}`);
    const initial = out ? 'skipped' : 'planned';
    const [item] = await tx
      .insert(items)
      .values({
        tenantId,
        batchId,
        nominationId: n.nominationId,
        objectId: n.objectId,
        subjectEmployeeId: n.employeeId,
        kind: n.kind,
        direction: n.direction,
        targetOrgId: n.orgId,
        targetPositionId: n.positionId,
        successorEmployeeId: n.successorEmployeeId,
        readinessId: readyIds.get(n.nominationId) ?? n.readinessId,
        planOutcome: out?.status === 'failed' ? 'failed' : initial,
        errorCode: out?.errorCode ?? null,
        errorParams: out?.errorParams ?? null,
        executionNo,
        pageCommandId,
      })
      .returning({ id: items.id });
    const target = savedTargets.find((t) => t.targetKind === n.kind && t.targetId === (n.orgId ?? n.positionId));
    if (target && !out) target.plannedItemIds = [...(target.plannedItemIds ?? []), item!.id];
  }
  if (savedTargets.length) await tx.insert(targets).values(savedTargets);
  return { registrations, outcomes: [...outcomes.values()], pending: savedTargets.some((t) => t.status === 'pending') };
}
