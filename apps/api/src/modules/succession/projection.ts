/**
 * 继任记录的响应投影（设计 §8.4）：先把记录行展开成完整视图（嵌套目标 / 准备度 / 人员，派生现任与负责人），
 * 再由 projectSuccession 按查看人在该对象上的字段权限裁剪——被隐藏的字段键缺席，嵌套对象跟随它所属的字段。
 * 嵌套人员照北森正常显示姓名(邮箱)，不按查看人数据范围隐藏（DEC-311③，用户选择的原站口径，审查不按泄露处理）。
 */
import type { Tx } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { isOpenEnded, type RecordRow } from './record-read.js';
import { loadIncumbentIds, loadPeople, loadPersonInChargeIds, type PersonView } from './read-sql.js';

export interface RecordView {
  readonly id: string;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly successionType: string;
  readonly targetOrgId: string | null;
  readonly targetPositionId: string | null;
  readonly successorEmployeeId: string;
  readonly readinessId: string | null;
  readonly backupType: string;
  readonly startDate: string;
  /** 长期有效（库内 9999-12-31）对外为 null；是否生效看 status。 */
  readonly endDate: string | null;
  readonly endReason: string | null;
  readonly endSource: string | null;
  readonly sourceKind: string;
  readonly status: 'active' | 'ended';
  readonly successor: PersonView | null;
  readonly targetOrg?: { readonly id: string; readonly name: string | null };
  readonly targetPosition?: { readonly id: string; readonly name: string | null; readonly orgId: string | null };
  readonly readiness: {
    readonly id: string;
    readonly code: string | null;
    readonly name: string | null;
    readonly color: string | null;
  } | null;
  /** 组织继任：asOf 当日的组织负责人（派生，D1 不存快照）。 */
  readonly personInCharge?: PersonView | null;
  /** 职位继任：asOf 当日的职位现任（派生）。 */
  readonly incumbents?: readonly PersonView[];
}

/** 展开记录行：人员姓名(邮箱)、现任 / 负责人都按 asOf 一次批量取，不逐行查询。 */
export async function buildRecordViews(
  tx: Tx,
  tenantId: string,
  rows: readonly RecordRow[],
  asOf: string,
): Promise<RecordView[]> {
  const positionIds = rows.flatMap((row) => (row.targetPositionId ? [row.targetPositionId] : []));
  const orgIds = rows.flatMap((row) => (row.targetOrgId ? [row.targetOrgId] : []));
  const [incumbents, heads] = await Promise.all([
    loadIncumbentIds(tx, tenantId, positionIds, asOf),
    loadPersonInChargeIds(tx, tenantId, orgIds, asOf),
  ]);
  const wanted = [
    ...rows.map((row) => row.successorEmployeeId),
    ...[...incumbents.values()].flat(),
    ...[...heads.values()].flatMap((id) => (id ? [id] : [])),
  ];
  const people = await loadPeople(tx, tenantId, wanted);
  const person = (id: string | null | undefined) => (id ? (people.get(id) ?? null) : null);

  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    successionType: row.successionType,
    targetOrgId: row.targetOrgId,
    targetPositionId: row.targetPositionId,
    successorEmployeeId: row.successorEmployeeId,
    readinessId: row.readinessId,
    backupType: row.backupType,
    startDate: row.startDate,
    endDate: isOpenEnded(row.endDate) ? null : row.endDate,
    endReason: row.endReason,
    endSource: row.endSource,
    sourceKind: row.sourceKind,
    status: row.status,
    successor: person(row.successorEmployeeId),
    readiness: row.readinessId
      ? { id: row.readinessId, code: row.readinessCode, name: row.readinessName, color: row.readinessColor }
      : null,
    ...(row.successionType === 'org'
      ? {
          targetOrg: { id: row.targetOrgId!, name: row.targetOrgName },
          personInCharge: person(heads.get(row.targetOrgId!)),
        }
      : {
          targetPosition: { id: row.targetPositionId!, name: row.targetPositionName, orgId: row.positionOrgId },
          incumbents: (incumbents.get(row.targetPositionId!) ?? []).flatMap((id) => person(id) ?? []),
        }),
  }));
}

/** 嵌套展示键 → 它所属的对象字段：字段不可查看时嵌套对象一起缺席。 */
const GOVERNING_FIELD: Readonly<Record<string, string>> = {
  successor: 'successorEmployeeId',
  targetOrg: 'targetOrgId',
  targetPosition: 'targetPositionId',
  readiness: 'readinessId',
};

type ProjectionKind = 'record';
const OBJECT_OF: Readonly<Record<ProjectionKind, string>> = { record: SUCCESSION_OBJECTS.record.code };

/**
 * 投影函数（§8.4 `projectSuccession`）：先按对象查看字段裁剪（getModuleViewableFields，键缺席），列表、详情、
 * 以及之后写入口的首次响应 / 重放共用。看全部字段时（fields === undefined）原样返回。
 */
export async function projectSuccession<T extends object>(
  deps: Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>,
  ctx: TenantContext,
  kind: ProjectionKind,
  items: readonly T[],
): Promise<Partial<T>[]> {
  const fields = await getModuleViewableFields(deps, ctx, OBJECT_OF[kind]);
  if (fields === undefined) return [...items];
  return items.map(
    (item) =>
      Object.fromEntries(Object.entries(item).filter(([key]) => fields.has(GOVERNING_FIELD[key] ?? key))) as Partial<T>,
  );
}
