/**
 * 时点花名册的权限链（列表与导出共用，不导出比列表更多的行或列）：
 * 人事分析对象查看权（导出另须列表级“导出”按钮）→ 员工档案对象查看权与数据范围（access，DEC-043 / AC-HA-05，
 * 范围先于分页）→ 逐列字段权（人员 / 任职记录 / 合同三个对象，后两者另须对象查看权，无权的整列缺席）。
 */
import {
  PERSONNEL_OBJECT,
  buttonResource,
  MODULE_OBJECTS,
  ROSTER_COLUMNS,
  ROSTER_FIXED_COLUMNS,
} from '@italent/domain';
import type { RosterColumn, RosterSource } from '@italent/domain';
import type { Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { access, type AccessContext } from '../personnel/access.js';

export const ROSTER_OBJECT = MODULE_OBJECTS.hrRoster.code;
const RECORD_OBJECT = MODULE_OBJECTS.employmentRecord.code;
const CONTRACT_OBJECT = MODULE_OBJECTS.contract.code;
const SOURCE_OBJECTS: Readonly<Record<RosterSource, string>> = {
  person: PERSONNEL_OBJECT,
  record: RECORD_OBJECT,
  contract: CONTRACT_OBJECT,
};

export interface RosterAccess {
  readonly ctx: AccessContext;
  /** 可见列（固定列在前），列表与导出的列由它唯一决定。 */
  readonly columns: readonly RosterColumn[];
  readonly canSee: (source: RosterSource, field: string) => boolean;
}

export async function rosterAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  exporting: boolean,
): Promise<RosterAccess> {
  const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, undefined, 0, 'list');
  await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: ROSTER_OBJECT });
  if (exporting)
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(ROSTER_OBJECT, 'export', 'list'),
    });
  // 任职 / 合同对象无查看权不拒绝请求，只让对应的列整类缺席（披露，不是准入）
  const viewable: Record<RosterSource, boolean> = {
    person: true,
    record: await deps.authorize({ ...ctx, action: 'object.view', resource: RECORD_OBJECT }),
    contract: await deps.authorize({ ...ctx, action: 'object.view', resource: CONTRACT_OBJECT }),
  };
  const sets = new Map<RosterSource, ReadonlySet<string> | undefined | false>();
  for (const source of Object.keys(SOURCE_OBJECTS) as RosterSource[])
    sets.set(source, viewable[source] ? await getModuleViewableFields(deps, ctx, SOURCE_OBJECTS[source]) : false);
  const canSee = (source: RosterSource, field: string) => {
    const fields = sets.get(source);
    return fields === undefined || (fields !== false && fields.has(field));
  };
  const columns = [...ROSTER_FIXED_COLUMNS, ...ROSTER_COLUMNS].filter((column) =>
    column.gate.every(([source, field]) => canSee(source, field)),
  );
  return { ctx, columns, canSee };
}

/** 筛选条件涉及的字段无查看权 → 403（同 personnel 列表：不能用看不到的字段探测值）。 */
export function requireFilterField(rights: RosterAccess, source: RosterSource, field: string) {
  if (!rights.canSee(source, field)) throw new AppError('FORBIDDEN', '花名册筛选字段不可查看');
}
