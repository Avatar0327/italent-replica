/**
 * 社保追加审计里的“原值”（F-474-8c-2c 第 3 轮，设计 §4.3 / DEC-896④）：追加审计的前镜像（before / changes.from）存的是
 * 本单业务位置之前折叠出的社保档案值，键沿用员工字段名 adjustedInsurance*；它们属于社保档案对象，查询出口按查看人
 * **当前**对 SocialSecurityProfile 的对象查看权与对应原值字段权裁剪（fail-closed：没有对象查看权或字段权被撤，该项原值
 * 一律去掉）。后镜像（after / changes.to）是任职记录对象的调整字段，仍由字段级裁剪（visibleValue / visibleChanges）按
 * 任职字段权处理，不在这里改。差异里写入时保存的派生文本（fromText / toText）带着旧内容，丢掉让出口按裁剪后的值重新生成。
 * 不新增授权对象、字段或授权版本。
 */
import { MODULE_OBJECTS, type AuditFieldChange } from '@italent/domain';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { getModuleViewableFields } from '../modules/permission/module-access.js';
import type { SourceRedactor } from './qualification-sources.js';
import { INSURANCE_ARCHIVE_AUDIT_TYPE } from './transfer-linkage.js';

const PROFILE = MODULE_OBJECTS.socialSecurityProfile.code;
/** 追加审计里的员工字段名 → 社保档案对象的原值字段。 */
const ORIGIN_FIELD: Readonly<Record<string, string>> = {
  adjustedInsuranceRegionCode: 'insuranceRegionCode',
  adjustedInsurancePlanId: 'insurancePlanId',
  adjustedInsuranceCompanyId: 'insuranceCompanyId',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 查看人当前不可见的原值键（员工字段名）：没有档案对象查看权时三项全隐藏。 */
async function hiddenOrigins(deps: TenantRouteDeps, ctx: TenantContext): Promise<ReadonlySet<string>> {
  const all = Object.keys(ORIGIN_FIELD);
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: PROFILE, fields: [] }))) return new Set(all);
  const viewable = await getModuleViewableFields(deps, ctx, PROFILE);
  return new Set(viewable === undefined ? [] : all.filter((key) => !viewable.has(ORIGIN_FIELD[key]!)));
}

interface OriginRow {
  readonly objectType: string;
  readonly before: unknown;
  readonly changes: unknown;
}

function redactOrigin<T extends OriginRow>(row: T, hidden: ReadonlySet<string>): T {
  const before = isObject(row.before)
    ? Object.fromEntries(Object.entries(row.before).filter(([key]) => !hidden.has(key)))
    : row.before;
  const changes = Array.isArray(row.changes)
    ? (row.changes as AuditFieldChange[]).flatMap((change) => {
        if (!hidden.has(change.field)) return [change];
        // 原值一侧去掉；新值一侧不动，两边都为空的条目不再出现
        if (change.to === null || change.to === undefined) return [];
        const { fromText: _from, toText: _to, ...rest } = change;
        return [{ ...rest, from: null }];
      })
    : row.changes;
  return { ...row, before, changes };
}

export async function insuranceSources(deps: TenantRouteDeps, ctx: TenantContext): Promise<SourceRedactor> {
  const hidden = await hiddenOrigins(deps, ctx);
  return {
    async redact(_tx, rows) {
      if (!hidden.size) return [...rows];
      return rows.map((row) => (row.objectType === INSURANCE_ARCHIVE_AUDIT_TYPE ? redactOrigin(row, hidden) : row));
    },
  };
}
