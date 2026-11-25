/**
 * 嵌套在审批载荷里、属于其他业务对象的字段（R1-T10 调动的合同变更，PR #74 第三轮 P1-1，DEC-057 / DEC-058）。
 * 这些字段的披露与盲审不按本单对象（任职记录）的字段权限，而按所属对象逐项判断：对象查看权、对目标记录的数据范围
 * （含“我创建的”）与该对象的字段查看权，三者都满足才可见。节点表单上的区块字段（container）含其下全部嵌套字段。
 * 详情、审批动作与同人自动跳过三处共用本判定；没有判定入口的调用方一律按看不到处理（fail-closed）。
 */
import type { Tx } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { checkScope } from '../contracts/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';

export interface ForeignField {
  /** 载荷中的字段编码，如 `contractChange.endDate`。 */
  readonly code: string;
  /** 节点表单上的区块字段（任职对象字段），如 `contractChange`。 */
  readonly container: string;
  readonly objectCode: string;
  /** 所属对象上的字段编码。 */
  readonly field: string;
  /** 目标记录的归属：员工与创建人（数据范围判定用）。 */
  readonly employeeId: string;
  readonly creatorId: string | null;
}

export type ForeignVisible = (field: ForeignField) => Promise<boolean>;

interface ForeignSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly foreignFields?: readonly ForeignField[];
}

/** 在本单对象的可见字段上替换嵌套字段的可见性；base 为 undefined（不受限）时以载荷中的本对象字段为准。 */
export async function viewableWithForeign(
  snapshot: ForeignSnapshot,
  base: ReadonlySet<string> | undefined,
  visible: ForeignVisible | undefined,
): Promise<ReadonlySet<string> | undefined> {
  const foreign = snapshot.foreignFields ?? [];
  if (!foreign.length) return base;
  const codes = new Set(foreign.map((field) => field.code));
  const own = [...(base ?? Object.keys(snapshot.values))].filter((code) => !codes.has(code));
  const allowed: string[] = [];
  // 第 3 轮 P1-4：容器字段（如 transferItems.contractChange）本身不可见时，其下逐行字段一并不可见（容器 ∩ 逐行对象权限）
  for (const field of foreign) {
    if (base !== undefined && !base.has(field.container)) continue;
    if (visible && (await visible(field))) allowed.push(field.code);
  }
  return new Set([...own, ...allowed]);
}

/** 节点表单含区块字段时，其下嵌套字段一并在表单上（是否可见另按 viewableWithForeign）。 */
export function formFieldsWithForeign(formFields: readonly string[], snapshot: ForeignSnapshot): string[] {
  const nested = (snapshot.foreignFields ?? []).filter((field) => formFields.includes(field.container));
  return [...formFields, ...nested.map((field) => field.code)];
}

/**
 * 已办读（冻结办理份）下嵌套字段的可见性再套一道办理时上限（P1-5，设计 §5.2「办理时不可见，后来授权也不补露」）：
 * 逐行编码 ∩ 办理时该办理人看得见的编码 ∩ 当前权限。ceiling 为 null = 现值读，不设限。
 */
export function capForeign(visible: ForeignVisible, ceiling: ReadonlySet<string> | null): ForeignVisible {
  if (!ceiling) return visible;
  return async (field) => ceiling.has(field.code) && (await visible(field));
}

/** 按某用户在事务内解析嵌套字段可见性；按对象记忆授权、范围与字段集合。 */
export function foreignVisibility(
  deps: Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>,
  ctx: TenantContext,
  tx: Tx,
): ForeignVisible {
  const objects = new Map<string, ReturnType<typeof objectAccess>>();
  return async (field) => {
    // 嵌入审批载荷的只有合同对象与社保档案对象；其他对象没有判定入口，按看不到处理。
    const profile = field.objectCode === MODULE_OBJECTS.socialSecurityProfile.code;
    if (field.objectCode !== CONTRACT_OBJECT && !profile) return false;
    if (!objects.has(field.objectCode)) objects.set(field.objectCode, objectAccess(deps, ctx, tx, field.objectCode));
    const access = await objects.get(field.objectCode)!;
    if (!access.view || (access.fields !== undefined && !access.fields.has(field.field))) return false;
    // 社保原值只看对象与字段查看权，不查员工数据范围（DEC-896④）。
    if (profile) return true;
    try {
      await checkScope(
        tx,
        { ...ctx, now: deps.clock(), commandId: '', expectedRevision: 0, scope: access.scope },
        field.employeeId,
        field.creatorId ?? undefined,
      );
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  };
}

async function objectAccess(
  deps: Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>,
  ctx: TenantContext,
  tx: Tx,
  objectCode: string,
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const view = await authorize({ ...ctx, action: 'object.view', resource: objectCode });
  return {
    view,
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode, `${objectCode}.list`),
    fields: await getModuleViewableFieldsInTransaction(deps, ctx, objectCode, tx),
  };
}
