import { ORG_DIMENSIONS, type OrgDimension, tenantLocalDate } from '@italent/domain';
import { eq, isUuid, orgSettings, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { loadOrgSnapshot, type OrgRecord } from './read-model.js';

export interface OrgWriteContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly rootName: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

export interface OrgParentInput {
  readonly parentId: string;
  readonly sequence?: number | null;
}

export type OrgParentsInput = { readonly admin: OrgParentInput } & Partial<Record<OrgDimension, OrgParentInput>>;

export interface OrganizationInput {
  readonly name: string;
  readonly parents: OrgParentsInput;
  readonly startDate?: string;
  readonly stopDate?: string;
  readonly code?: string;
  readonly reservationId?: string;
  readonly enabled?: boolean;
  readonly broadType?: string;
  readonly shortName?: string | null;
  readonly establishedOn?: string | null;
  readonly personInChargeId?: string | null;
  readonly hrbpId?: string | null;
  readonly costCenterId?: string | null;
  readonly location?: string | null;
  readonly remarks?: string | null;
  readonly displayOrder?: number | null;
  readonly isVirtual?: boolean;
  readonly confirmed?: boolean;
}

export type OrganizationPatch = Partial<Omit<OrganizationInput, 'reservationId' | 'startDate' | 'parents'>> & {
  readonly effectiveDate: string;
  readonly parents?: Partial<Record<OrgDimension, OrgParentInput>>;
};

export interface NormalizedOrganization {
  readonly name: string;
  readonly parents: Partial<Record<OrgDimension, { parentId: string; sequence: number | null }>>;
  readonly startDate: string;
  readonly stopDate: string;
  readonly enabled: boolean;
  readonly broadType: string;
  readonly shortName: string | null;
  readonly establishedOn: string | null;
  readonly personInChargeId: string | null;
  readonly hrbpId: string | null;
  readonly costCenterId: string | null;
  readonly location: string | null;
  readonly remarks: string | null;
  readonly displayOrder: number | null;
  readonly isVirtual: boolean;
}

export function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { fields: { [field]: message } });
}

/** 不信任 HTTP 输入；结构化人员引用不能拿平台账号冒充员工主数据。 */
export function normalizeOrganization(ctx: OrgWriteContext, input: OrganizationInput): NormalizedOrganization {
  if (!input || typeof input !== 'object') throw invalid('organization', '组织信息必须是对象');
  const name = requiredText(input.name, 'name');
  const startDate = date(input.startDate ?? tenantLocalDate(ctx.now, ctx.timezone), 'startDate');
  const stopDate = date(input.stopDate ?? '9999-12-31', 'stopDate');
  if (stopDate < startDate) throw invalid('stopDate', '失效日期不得早于生效日期');
  validateCodeFields(input);
  const personInChargeId = reference(input.personInChargeId, 'personInChargeId');
  const hrbpId = reference(input.hrbpId, 'hrbpId');
  const costCenterId = reference(input.costCenterId, 'costCenterId');
  // TODO(需取证 R1-T03 人员引用): 员工主数据落地后验证人员存在性、租户与当前访问权限。
  if (personInChargeId || hrbpId) {
    throw new AppError('SERVICE_UNAVAILABLE', '员工主数据验证尚未接入，暂不能保存负责人或 HRBP');
  }
  // TODO(需取证 R1-T03 成本中心引用): 成本中心独立对象接入后验证对象存在性及租户归属。
  if (costCenterId) throw new AppError('SERVICE_UNAVAILABLE', '成本中心主数据验证尚未接入，暂不能保存引用');
  return {
    name,
    startDate,
    stopDate,
    parents: normalizeParents(input.parents),
    enabled: flag(input.enabled, 'enabled', true),
    broadType: requiredText(input.broadType ?? '部门', 'broadType'),
    shortName: optionalText(input.shortName, 'shortName'),
    establishedOn: input.establishedOn == null ? null : date(input.establishedOn, 'establishedOn'),
    personInChargeId,
    hrbpId,
    costCenterId,
    location: optionalText(input.location, 'location'),
    remarks: optionalText(input.remarks, 'remarks'),
    displayOrder: integer(input.displayOrder, 'displayOrder'),
    isVirtual: flag(input.isVirtual, 'isVirtual', false),
  };
}

export async function validateHierarchy(
  tx: Tx,
  ctx: OrgWriteContext,
  input: NormalizedOrganization,
  orgId?: string,
  preservedParents?: OrgRecord['parents'],
): Promise<OrgRecord[]> {
  const [settings] = await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, ctx.tenantId));
  const nodes = await loadOrgSnapshot(tx, ctx.tenantId, input.startDate);
  for (const dimension of ORG_DIMENSIONS) {
    const parent = input.parents[dimension];
    if (!parent) continue;
    const preserved = preservedParents?.[dimension];
    const unchanged = preserved?.parentId === parent.parentId && preserved.sequence === parent.sequence;
    if (dimension !== 'admin' && !settings?.[`${dimension}Enabled`] && !unchanged) {
      throw invalid(`parents.${dimension}`, '该组织维度尚未开启');
    }
    const existing = nodes.find((node) => node.id === parent.parentId);
    if (parent.parentId !== ctx.tenantId && !existing) {
      throw invalid(`parents.${dimension}.parentId`, '上级组织不存在或不在当前租户生效');
    }
    assertNoCycle(nodes, dimension, parent.parentId, orgId);
  }
  return nodes;
}

function assertNoCycle(nodes: OrgRecord[], dimension: OrgDimension, parentId: string, orgId?: string): void {
  const visited = new Set<string>();
  let cursor: string | null | undefined = parentId;
  while (cursor) {
    if (cursor === orgId || visited.has(cursor)) {
      throw invalid(`parents.${dimension}`, '组织层级不得形成循环');
    }
    visited.add(cursor);
    cursor = nodes.find((node) => node.id === cursor)?.parents[dimension]?.parentId;
  }
}

export function assertSnapshotAcyclic(nodes: OrgRecord[]): void {
  for (const node of nodes) {
    for (const dimension of ORG_DIMENSIONS) {
      const parentId = node.parents[dimension]?.parentId;
      if (parentId) assertNoCycle(nodes, dimension, parentId, node.id);
    }
  }
}

function normalizeParents(value: OrgParentsInput): NormalizedOrganization['parents'] {
  if (!value || typeof value !== 'object' || !value.admin) {
    throw invalid('parents.admin', '行政维度上级必填');
  }
  const result: NormalizedOrganization['parents'] = {};
  for (const key of Object.keys(value)) {
    if (!ORG_DIMENSIONS.includes(key as OrgDimension)) throw invalid(`parents.${key}`, '未知组织维度');
  }
  for (const dimension of ORG_DIMENSIONS) {
    const parent = value[dimension];
    if (parent === undefined) continue;
    if (!parent || typeof parent !== 'object') throw invalid(`parents.${dimension}`, '上级信息必须是对象');
    if (typeof parent.parentId !== 'string' || !isUuid(parent.parentId)) {
      throw invalid(`parents.${dimension}.parentId`, '上级组织 ID 必须是 UUID');
    }
    result[dimension] = {
      parentId: parent.parentId,
      sequence: integer(parent.sequence, `parents.${dimension}.sequence`),
    };
  }
  return result;
}

function validateCodeFields(input: OrganizationInput): void {
  if (input.code !== undefined) requiredText(input.code, 'code');
  if (input.reservationId !== undefined && (typeof input.reservationId !== 'string' || !isUuid(input.reservationId))) {
    throw invalid('reservationId', '编码预占 ID 必须是 UUID');
  }
  if (input.confirmed !== undefined) flag(input.confirmed, 'confirmed', false);
}

export function date(value: string, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid(field, '日期必须使用 YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '0001-01-01') {
    throw invalid(field, '业务日期不合法');
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(field, '该字段必须是非空文本');
  return value.trim();
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid(field, '该字段必须是文本');
  return value;
}

function reference(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !isUuid(value)) throw invalid(field, '引用 ID 必须是 UUID');
  return value;
}

function integer(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw invalid(field, '顺序号必须是整数');
  }
  return value;
}

function flag(value: boolean | undefined, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(field, '该字段必须是布尔值');
  return value;
}
