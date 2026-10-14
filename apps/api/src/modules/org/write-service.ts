import {
  applyOrgEmploymentLinkage,
  lockOrgEmploymentTargets,
  validateEmploymentChoice,
  type OrgEmploymentBatch,
} from './employment-linkage.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import type { Authorizer } from '../../authorization.js';
import { linkedObjectScope, type ModuleScope } from '../permission/module-access.js';
import { auditActor } from '../../system-actor.js';
import { recordAudit } from '../../audit/record.js';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isUuid, orgHierarchyLinks, orgObjects, orgVersions, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertCodeAvailable, consumeCode, ensureOrgSetup } from './codes.js';
import { applyEstablishedOnCorrection, planEstablishedOnCorrection } from './correction.js';
import { assertParentAvailable, type CascadeAuthorizer, planDeactivation, unavailableFrom } from './deactivation.js';
import { assertOrgPeopleEligible, submittedPeople } from './people.js';
import { futureBoundaries, loadOrgSnapshot, type OrgPath, type OrgRecord, resolveOrgPaths } from './read-model.js';
import {
  assertSnapshotAcyclic,
  date,
  invalid,
  normalizeCreation,
  normalizeOrganization,
  type NormalizedOrganization,
  type OrganizationInput,
  type OrganizationPatch,
  type OrganizationVersionInput,
  type OrgParentsInput,
  type OrgWriteContext,
  validateHierarchy,
} from './validation.js';

export type { CascadeAuthorizer } from './deactivation.js';
export type {
  OrganizationInput,
  OrganizationPatch,
  OrgParentInput,
  OrgParentsInput,
  OrgWriteContext,
} from './validation.js';

export interface EstablishmentAssessment {
  readonly isBeyondEstablishment: boolean;
  readonly strictControl: boolean;
}

export type EstablishmentAssessor = (
  tx: Tx,
  ctx: OrgWriteContext,
  input: OrganizationInput,
) => Promise<EstablishmentAssessment>;

export interface OrganizationValidation extends EstablishmentAssessment {
  readonly requiresConfirmation: boolean;
  readonly canSubmit: boolean;
  readonly fields: Record<string, string>;
}

// TODO(需取证 Q-M0-08): T04 接入真实编制数据和组织新建超编的计算规则。
const noEstablishmentRule: EstablishmentAssessor = async () => ({
  isBeyondEstablishment: false,
  strictControl: false,
});

/** AC-ORG-04：预检纯读取，不初始化根、不预占编码，也不接受客户端自报的超编标志。 */
export async function validateOrganization(
  tx: Tx,
  ctx: OrgWriteContext,
  input: OrganizationInput,
  assess: EstablishmentAssessor = noEstablishmentRule,
): Promise<OrganizationValidation> {
  const normalized = normalizeCreation(ctx, input);
  await validateHierarchy(tx, ctx, normalized);
  await assertParentAvailable(tx, ctx, normalized);
  await assertOrgPeopleEligible(tx, ctx, submittedPeople(input), normalized.startDate);
  const assessment = await assess(tx, ctx, input);
  const requiresConfirmation = assessment.isBeyondEstablishment && !assessment.strictControl;
  return {
    ...assessment,
    requiresConfirmation,
    canSubmit: !assessment.isBeyondEstablishment || (!assessment.strictControl && input.confirmed === true),
    fields: {},
  };
}

export async function createOrganization(
  tx: Tx,
  ctx: OrgWriteContext,
  input: OrganizationInput,
  assess: EstablishmentAssessor = noEstablishmentRule,
): Promise<OrgRecord> {
  assertRevision(ctx.expectedRevision, 0);
  const normalized = normalizeCreation(ctx, input);
  await ensureOrgSetup(tx, ctx);
  const validation = await validateOrganization(tx, ctx, input, assess);
  assertCanSubmit(validation);
  const nodes = await validateHierarchy(tx, ctx, normalized);
  const code = await consumeCode(tx, ctx, input);
  const id = randomUUID();
  await tx.insert(orgObjects).values({ id, tenantId: ctx.tenantId, revision: 1, createdAt: ctx.now });
  const path = parentPath(ctx, normalized, nodes);
  const saved = await appendVersion(tx, ctx, id, code, 1, normalized, path, null);
  await audit(tx, ctx, 'org.create', id, null, saved);
  return saved;
}

export interface OrgUpdateOptions {
  /** DEC-129 级联停用前，按操作人当前数据范围逐个校验下级组织（路由提供）。 */
  readonly authorizeCascade?: CascadeAuthorizer;
  readonly employmentScope?: ModuleScope;
  /** 导入已在组织锁之前取得全批员工锁，行内只能使用该集合。 */
  readonly employmentBatch?: OrgEmploymentBatch;
}

/** 业务字段全部追加版本；对象头只保存稳定标识、可修改的业务编码及全局 revision。 */
export async function updateOrganization(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  patch: OrganizationPatch,
  options: OrgUpdateOptions = {},
): Promise<OrgRecord> {
  if (!isUuid(orgId)) throw invalid('orgId', '组织 ID 必须是 UUID');
  orgId = orgId.toLowerCase();
  if (orgId === ctx.tenantId) throw new AppError('FORBIDDEN', '租户根组织不可修改');
  if (!patch || typeof patch !== 'object') throw invalid('organization', '组织变更必须是对象');
  if (patch.parents !== undefined && (!patch.parents || typeof patch.parents !== 'object')) {
    throw invalid('parents', '上级信息必须是对象');
  }
  const effectiveDate = date(patch.effectiveDate, 'effectiveDate');
  const employmentCtx = { ...ctx, scope: options.employmentScope };
  const lockedEmployees =
    patch.addEmployment === true
      ? await lockOrgEmploymentTargets(tx, employmentCtx, orgId, effectiveDate, options.employmentBatch)
      : [];
  await ensureOrgSetup(tx, ctx);
  const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, orgId)).for('no key update');
  if (!object) throw new AppError('NOT_FOUND', '组织不存在');
  assertRevision(ctx.expectedRevision, object.revision);
  await rejectEarlierThanFutureVersion(tx, ctx, orgId, effectiveDate);
  if (patch.establishedOn !== undefined) await assertEstablishedOnUnchanged(tx, ctx, orgId, patch.establishedOn);
  const current = await recordAt(tx, object, effectiveDate);
  const addEmployment = validateEmploymentChoice(current, patch);
  const normalized = normalizeOrganization(ctx, mergePatch(current, patch, effectiveDate));
  const nodes = await validateHierarchy(tx, ctx, normalized, orgId, current.parents);
  await assertParentAvailable(tx, ctx, normalized);
  await assertOrgPeopleEligible(tx, ctx, submittedPeople(patch, current), effectiveDate);
  const code = patch.code?.trim() ?? current.code;
  if (code !== current.code) await assertCodeAvailable(tx, ctx, code, effectiveDate, orgId);
  const revision = object.revision + 1;
  await tx.update(orgObjects).set({ revision }).where(objectKey(ctx.tenantId, orgId));
  const path = parentPath(ctx, normalized, nodes);
  const saved = await appendVersion(tx, ctx, orgId, code, revision, normalized, path, current);
  // DEC-129、`10` §9：停用（或失效日期提前）时整支下级同日级联停用；整支仍有在职人员或启用职位则整单拒绝。
  const from = unavailableFrom(current, normalized);
  if (from) {
    const descendants = await planDeactivation(tx, ctx, saved, from, options.authorizeCascade);
    await disableDescendants(tx, ctx, descendants, from);
  }
  await validateFutureSnapshots(tx, ctx, effectiveDate);
  if (addEmployment) await applyOrgEmploymentLinkage(tx, employmentCtx, orgId, effectiveDate, lockedEmployees);
  await audit(tx, ctx, 'org.update', orgId, current, saved);
  // 改名或改行政上级不给下级追加全称版本：下级全称在读取时按当天的上级名称解析（read-model 的 resolveOrgPaths）。
  return saved;
}

/**
 * DEC-147（`10` §18）：「变更」中没有设立日期字段；原样提交（整表提交的客户端）放行，改动或清空一律 400，
 * 到「编辑」（PATCH …/correction）中修改，首版生效日随之变化（DEC-130）。存量缺设立日期的可按首版生效日补齐。
 */
async function assertEstablishedOnUnchanged(tx: Tx, ctx: OrgWriteContext, orgId: string, value: string | null) {
  const [first] = await tx
    .select({ startDate: orgVersions.startDate })
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, ctx.tenantId), eq(orgVersions.orgId, orgId)))
    .orderBy(orgVersions.startDate)
    .limit(1);
  if (value !== null && value === first?.startDate) return;
  throw new AppError('VALIDATION_FAILED', '「变更」中不能修改设立日期，请在「编辑」中修改', {
    reason: 'ESTABLISHED_ON_EDIT_ONLY',
    fields: { establishedOn: '设立日期请在「编辑」中修改' },
  });
}

/** DEC-147：「编辑」更正设立日期，首版生效日随之变化，不产生新版本；拦截规则与原地更正见 correction.ts。 */
export async function correctEstablishedOn(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  value: string,
): Promise<OrgRecord> {
  if (!isUuid(orgId)) throw invalid('orgId', '组织 ID 必须是 UUID');
  orgId = orgId.toLowerCase();
  if (orgId === ctx.tenantId) throw new AppError('FORBIDDEN', '租户根组织不可修改');
  const establishedOn = date(value, 'establishedOn');
  const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, orgId)).for('no key update');
  if (!object) throw new AppError('NOT_FOUND', '组织不存在');
  assertRevision(ctx.expectedRevision, object.revision);
  const plan = await planEstablishedOnCorrection(tx, ctx, orgId, establishedOn);
  if (plan) {
    const revision = object.revision + 1;
    await tx.update(orgObjects).set({ revision }).where(objectKey(ctx.tenantId, orgId));
    await applyEstablishedOnCorrection(tx, ctx, orgId, plan);
    // 更正不追加任何版本（PR #54 P2-A）：提前后新覆盖的那几天里上级名称可能不同，全称读取时按当天解析，无需派生版本。
    await audit(
      tx,
      ctx,
      'org.established-on.correct',
      orgId,
      plan.before,
      await recordAt(tx, { ...object, revision }, establishedOn),
    );
  }
  const [latest] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, orgId));
  return recordAt(tx, latest ?? object, establishedOn);
}

/** DEC-129：下级按停用日当天的状态原样追加一个停用版本，各自 revision 前进并留审计。 */
async function disableDescendants(tx: Tx, ctx: OrgWriteContext, nodes: readonly OrgRecord[], from: string) {
  for (const node of nodes) {
    const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, node.id)).for('no key update');
    if (!object) throw new AppError('SERVICE_UNAVAILABLE', '下级组织不存在');
    const revision = object.revision + 1;
    await tx.update(orgObjects).set({ revision }).where(objectKey(ctx.tenantId, node.id));
    const input = normalizeOrganization(ctx, {
      ...node,
      startDate: from,
      enabled: false,
      parents: node.parents as OrgParentsInput,
    });
    const path = { fullName: node.fullName, level: node.level };
    const saved = await appendVersion(tx, ctx, node.id, node.code, revision, input, path, node);
    await audit(tx, ctx, 'org.disable.cascade', node.id, node, saved);
  }
}

async function rejectEarlierThanFutureVersion(tx: Tx, ctx: OrgWriteContext, orgId: string, effectiveDate: string) {
  const [future] = await tx
    .select({ id: orgVersions.id })
    .from(orgVersions)
    .where(
      and(
        eq(orgVersions.tenantId, ctx.tenantId),
        eq(orgVersions.orgId, orgId),
        // TODO(需取证 Q-M0-06): 原站是否拒绝在已排定版本前插入变更。
        sql`${orgVersions.startDate} > ${effectiveDate}`,
      ),
    )
    .limit(1);
  if (future) throw new AppError('ORG_FUTURE_VERSION_EXISTS', '组织已有后续版本，请先处理后续版本');
}

function assertCanSubmit(validation: OrganizationValidation): void {
  if (validation.canSubmit) return;
  const reason = validation.strictControl ? 'ESTABLISHMENT_EXCEEDED' : 'CONFIRMATION_REQUIRED';
  throw new AppError('CONFLICT', validation.strictControl ? '组织编制严格控制，不允许超编提交' : '需要确认超编提示', {
    reason,
  });
}

function assertRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new AppError('REVISION_CONFLICT', '组织已被他人修改，请刷新后显式重提', { expected, actual });
  }
}

function objectKey(tenantId: string, orgId: string) {
  return and(eq(orgObjects.tenantId, tenantId), eq(orgObjects.id, orgId));
}

function mergePatch(current: OrgRecord, patch: OrganizationPatch, effectiveDate: string): OrganizationVersionInput {
  const parents: Record<string, { parentId: string; sequence?: number | null }> = { ...current.parents } as Record<
    string,
    { parentId: string; sequence?: number | null }
  >;
  for (const [dimension, change] of Object.entries(patch.parents ?? {})) {
    parents[dimension] = {
      ...current.parents[dimension as keyof OrgParentsInput],
      ...change,
    };
  }
  return { ...current, ...patch, startDate: effectiveDate, parents: parents as unknown as OrgParentsInput };
}

/** 停用或失效组织仍能追加恢复版本；只能从生效日之前最近的一条继承，不能读取未来业务值。 */
async function recordAt(tx: Tx, object: typeof orgObjects.$inferSelect, effectiveDate: string): Promise<OrgRecord> {
  const rows = await tx
    .select()
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, object.tenantId), eq(orgVersions.orgId, object.id)))
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo));
  const version = rows.find((row) => row.startDate <= effectiveDate);
  if (!version) throw invalid('effectiveDate', '变更生效日期不得早于组织首个版本');
  const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, version.id));
  const paths = await resolveOrgPaths(tx, object.tenantId, effectiveDate, [version.id]);
  return {
    ...version,
    ...paths.get(version.id),
    id: object.id,
    versionId: version.id,
    code: version.code,
    revision: object.revision,
    parents: Object.fromEntries(
      links.map((link) => [link.dimension, { parentId: link.parentOrgId, sequence: link.sequence }]),
    ),
  };
}

function parentPath(ctx: OrgWriteContext, input: NormalizedOrganization, nodes: OrgRecord[]): OrgPath {
  const parentId = input.parents.admin!.parentId;
  const parent = nodes.find((node) => node.id === parentId);
  const fullName = parentId === ctx.tenantId ? ctx.rootName : parent!.fullName;
  const level = parentId === ctx.tenantId ? 1 : parent!.level + 1;
  return { fullName: `${fullName}/${input.name}`, level };
}

async function appendVersion(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  code: string,
  revision: number,
  input: NormalizedOrganization,
  path: OrgPath,
  previous: OrgRecord | null,
): Promise<OrgRecord> {
  const { parents, ...fields } = input;
  const [version] = await tx
    .insert(orgVersions)
    .values({
      ...fields,
      ...path,
      code,
      orgId,
      tenantId: ctx.tenantId,
      versionNo: revision,
      previousVersionId: previous?.versionId ?? null,
      createdAt: ctx.now,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '组织版本保存失败');
  const links = Object.entries(parents).map(([dimension, parent]) => ({
    tenantId: ctx.tenantId,
    versionId: version.id,
    dimension: dimension as keyof typeof parents,
    parentOrgId: parent.parentId,
    sequence: parent.sequence,
  }));
  if (links.length) await tx.insert(orgHierarchyLinks).values(links);
  return { ...version, id: orgId, versionId: version.id, code, revision, parents };
}

async function validateFutureSnapshots(tx: Tx, ctx: OrgWriteContext, effectiveDate: string): Promise<void> {
  for (const boundary of await futureBoundaries(tx, ctx.tenantId, effectiveDate)) {
    assertSnapshotAcyclic(await loadOrgSnapshot(tx, ctx.tenantId, boundary));
  }
}

function auditFields(record: OrgRecord | null): unknown {
  if (!record) return null;
  const { createdAt: _createdAt, ...fields } = record;
  return fields;
}

async function audit(
  tx: Tx,
  ctx: OrgWriteContext,
  action: string,
  orgId: string,
  before: OrgRecord | null,
  after: OrgRecord,
): Promise<void> {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action,
    objectType: 'organization',
    objectId: orgId,
    before: auditFields(before),
    after: auditFields(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

/** R1-T09：可信调动联动端口。复用组织完整写入与 DEC-135 校验，调用者负责同事务 outbox。
 * 先沿组织端口的设置锁 → 对象锁顺序读 revision，不在任职模块直接写组织表。
 */
export async function assignTransferOrganizationPeople(
  tx: Tx,
  context: Omit<OrgWriteContext, 'rootName' | 'expectedRevision'> & { scope?: ModuleScope; authorize?: Authorizer },
  orgId: string,
  effectiveDate: string,
  people: { personInChargeId?: string; shopOwnerId?: string; hrbpId?: string },
): Promise<OrgRecord> {
  await requireTransferOrganizationScope(tx, context, orgId);
  const [root] = await tx
    .select({ name: orgVersions.name })
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, context.tenantId), eq(orgVersions.orgId, context.tenantId)))
    .orderBy(desc(orgVersions.versionNo))
    .limit(1);
  if (!root) throw new AppError('SERVICE_UNAVAILABLE', '组织根尚未初始化');
  const ctx = { ...context, rootName: root.name, expectedRevision: 0 };
  await ensureOrgSetup(tx, ctx);
  const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, orgId)).for('no key update');
  if (!object) throw new AppError('NOT_FOUND', '组织不存在');
  return updateOrganization(tx, { ...ctx, expectedRevision: object.revision }, orgId, { effectiveDate, ...people });
}

/** DEC-178：组织写范围独立于调入部门选择例外；任职可见性的并集不能扩展组织权限。
 * 复用 F-015 范围并集谓词，但组织写入没有员工当前部门这一扩展来源。
 */
export async function requireTransferOrganizationScope(
  tx: Tx,
  ctx: Pick<OrgWriteContext, 'tenantId' | 'userId' | 'timezone' | 'now'> & {
    scope?: ModuleScope;
    authorize?: Authorizer;
  },
  orgId: string,
): Promise<void> {
  const scope = await linkedObjectScope(tx, ctx, 'TenantBase.Organization');
  const allowed = await tx.execute(
    sql`SELECT 1 WHERE ${employmentVisibilitySql(scope, {
      employee: sql`NULL::uuid`,
      department: sql`${orgId}::uuid`,
    })}`,
  );
  if (!(Array.isArray(allowed) ? allowed : (allowed as { rows: unknown[] }).rows).length)
    throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不在当前数据范围，请由覆盖该范围的人员操作');
}
