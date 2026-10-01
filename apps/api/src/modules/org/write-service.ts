import { randomUUID } from 'node:crypto';
import { and, auditEvents, desc, eq, isUuid, orgHierarchyLinks, orgObjects, orgVersions, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertCodeAvailable, consumeCode, ensureOrgSetup } from './codes.js';
import { loadOrgSnapshot, type OrgRecord } from './read-model.js';
import {
  assertSnapshotAcyclic,
  date,
  invalid,
  normalizeOrganization,
  type NormalizedOrganization,
  type OrganizationInput,
  type OrganizationPatch,
  type OrgParentsInput,
  type OrgWriteContext,
  validateHierarchy,
} from './validation.js';

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

// TODO(需取证 #9): T04 接入真实编制数据和组织新建超编的计算规则。
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
  const normalized = normalizeOrganization(ctx, input);
  await validateHierarchy(tx, ctx, normalized);
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
  const normalized = normalizeOrganization(ctx, input);
  await ensureOrgSetup(tx, ctx);
  const validation = await validateOrganization(tx, ctx, input, assess);
  assertCanSubmit(validation);
  const nodes = await validateHierarchy(tx, ctx, normalized);
  const code = await consumeCode(tx, ctx, input);
  const id = randomUUID();
  await tx.insert(orgObjects).values({ id, tenantId: ctx.tenantId, code, revision: 1, createdAt: ctx.now });
  const path = parentPath(ctx, normalized, nodes);
  const saved = await appendVersion(tx, ctx, id, code, 1, normalized, path, null);
  await audit(tx, ctx, 'org.create', id, null, saved);
  return saved;
}

/** 业务字段全部追加版本；对象头只保存稳定标识、可修改的业务编码及全局 revision。 */
export async function updateOrganization(
  tx: Tx,
  ctx: OrgWriteContext,
  orgId: string,
  patch: OrganizationPatch,
): Promise<OrgRecord> {
  if (!isUuid(orgId)) throw invalid('orgId', '组织 ID 必须是 UUID');
  if (orgId === ctx.tenantId) throw new AppError('FORBIDDEN', '租户根组织不可修改');
  if (!patch || typeof patch !== 'object') throw invalid('organization', '组织变更必须是对象');
  if (patch.parents !== undefined && (!patch.parents || typeof patch.parents !== 'object')) {
    throw invalid('parents', '上级信息必须是对象');
  }
  const effectiveDate = date(patch.effectiveDate, 'effectiveDate');
  await ensureOrgSetup(tx, ctx);
  const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, orgId)).for('update');
  if (!object) throw new AppError('NOT_FOUND', '组织不存在');
  assertRevision(ctx.expectedRevision, object.revision);
  const current = await recordAt(tx, object, effectiveDate);
  const input = mergePatch(current, patch, effectiveDate);
  const normalized = normalizeOrganization(ctx, input);
  const nodes = await validateHierarchy(tx, ctx, normalized, orgId, current.parents);
  const code = patch.code?.trim() ?? object.code;
  if (code !== object.code) await assertCodeAvailable(tx, ctx, code, orgId);
  const revision = object.revision + 1;
  await tx.update(orgObjects).set({ code, revision }).where(objectKey(ctx.tenantId, orgId));
  const saved = await appendVersion(
    tx,
    ctx,
    orgId,
    code,
    revision,
    normalized,
    parentPath(ctx, normalized, nodes),
    current,
  );
  await validateFutureSnapshots(tx, ctx, effectiveDate);
  await audit(tx, ctx, 'org.update', orgId, current, saved);
  if (saved.fullName !== current.fullName) await synchronizeFullNames(tx, ctx, effectiveDate);
  return saved;
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

function mergePatch(current: OrgRecord, patch: OrganizationPatch, effectiveDate: string): OrganizationInput {
  const parents = { ...current.parents, ...patch.parents } as OrgParentsInput;
  return { ...current, ...patch, startDate: effectiveDate, parents };
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
  return {
    ...version,
    id: object.id,
    versionId: version.id,
    code: object.code,
    revision: object.revision,
    parents: Object.fromEntries(
      links.map((link) => [link.dimension, { parentId: link.parentOrgId, sequence: link.sequence }]),
    ),
  };
}

interface OrgPath {
  readonly fullName: string;
  readonly level: number;
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

/** DEC-021：本次及已排定的未来边界都追加全称版本，保留旧时点和子组织的其他业务字段。 */
async function synchronizeFullNames(tx: Tx, ctx: OrgWriteContext, effectiveDate: string): Promise<void> {
  const boundaries = await futureBoundaries(tx, ctx.tenantId, effectiveDate);
  for (const boundary of boundaries) {
    const nodes = await loadOrgSnapshot(tx, ctx.tenantId, boundary);
    for (const node of nodes) {
      if (node.id === ctx.tenantId) continue;
      const path = resolvePath(ctx, node, nodes, new Set());
      if (node.fullName === path.fullName && node.level === path.level) continue;
      const [object] = await tx.select().from(orgObjects).where(objectKey(ctx.tenantId, node.id)).for('update');
      if (!object) throw new AppError('SERVICE_UNAVAILABLE', '下级组织不存在');
      const revision = object.revision + 1;
      await tx.update(orgObjects).set({ revision }).where(objectKey(ctx.tenantId, node.id));
      const input = normalizeOrganization(ctx, {
        ...node,
        startDate: boundary,
        parents: node.parents as OrgParentsInput,
      });
      const saved = await appendVersion(tx, ctx, node.id, node.code, revision, input, path, node);
      await audit(tx, ctx, 'org.full-name.synchronize', node.id, node, saved);
    }
  }
}

async function validateFutureSnapshots(tx: Tx, ctx: OrgWriteContext, effectiveDate: string): Promise<void> {
  for (const boundary of await futureBoundaries(tx, ctx.tenantId, effectiveDate)) {
    assertSnapshotAcyclic(await loadOrgSnapshot(tx, ctx.tenantId, boundary));
  }
}

async function futureBoundaries(tx: Tx, tenantId: string, effectiveDate: string): Promise<string[]> {
  const versions = await tx
    .select({ startDate: orgVersions.startDate })
    .from(orgVersions)
    .where(eq(orgVersions.tenantId, tenantId));
  return [...new Set([effectiveDate, ...versions.map((row) => row.startDate)])]
    .filter((boundary) => boundary >= effectiveDate)
    .sort();
}

function resolvePath(ctx: OrgWriteContext, node: OrgRecord, nodes: OrgRecord[], visited: Set<string>): OrgPath {
  if (node.id === ctx.tenantId) return { fullName: ctx.rootName, level: 0 };
  if (visited.has(node.id)) throw invalid('parents.admin', '组织层级不得形成循环');
  visited.add(node.id);
  const parentId = node.parents.admin?.parentId;
  const parent = nodes.find((candidate) => candidate.id === parentId);
  if (!parent) return { fullName: node.fullName, level: node.level };
  const path = resolvePath(ctx, parent, nodes, visited);
  return { fullName: `${path.fullName}/${node.name}`, level: path.level + 1 };
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
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'organization',
    objectId: orgId,
    before: auditFields(before),
    after: auditFields(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}
