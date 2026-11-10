/**
 * 申请详情读接口共用的“内容来源 + 披露”判定（F-476 §5.4）：组织调整（P1）、合同 / 员工子集 / 兼职（P5）及之后各片共用，
 * 避免每个业务各抄一份 openDetail / 三重交集。
 * - 能打开最新审批实例的人（审批人、发起人、抄送人、范围内的流程管理员）才有内容来源；打不开返回 null，由调用方走各自原有的
 *   对象权限 + 数据范围路径（HR / 本人）或 404。
 * - 已办人且有办理份 → frozen：内容取办理份的 ext，披露集 = 办理时披露上限 ∩ 办理节点表单 ∩ 当前字段权限（DEC-801）；
 *   缺份 503，不退回现值（DEC-807）。其余 → live：披露集 = 节点表单 ∩ 当前字段权限。
 * - 审批人路径不要求数据范围（DEC-834④，沿用审批中心可打开口径）；字段权限始终取当前。
 */
import type { Tx } from '@italent/db';
import { APPROVAL_INSTANCE_OBJECT, buttonResource } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { memberInstanceScope } from './access.js';
import type { BusinessSnapshot, BusinessType } from './adapters.js';
import { disclosedFields, readDetail, type DetailData } from './disclosure.js';
import { contentViewOf } from './handling-content.js';
import { latestInstanceOf, type InstanceRow } from './store.js';

export type FrozenReadDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

/** 响应里的“内容来源”说明（与审批中心详情的 contentView 同形）。 */
export interface ContentView {
  readonly mode: 'live' | 'frozen';
  readonly instanceId: string | null;
  readonly taskId: string | null;
  readonly round: number | null;
  readonly actedAt: string | null;
}

export const LIVE_VIEW: ContentView = { mode: 'live', instanceId: null, taskId: null, round: null, actedAt: null };

/**
 * 审批中心同一判定（参与人或范围内的流程管理员）与同一份详情数据（含业务快照、查看人任务与抄送）；打不开返回 null。
 * 管理员范围在本事务内解析（PGlite 单连接）。
 */
export async function openApprovalDetail(
  tx: Tx,
  deps: FrozenReadDeps,
  ctx: TenantContext,
  instance: InstanceRow,
): Promise<DetailData | null> {
  // 授权器在自己的租户事务里判断：这里已占着 withTenant 的连接，必须绑到当前事务，否则管理员按钮判断会重入根事务而卡死
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const adminScope = async (button: 'adminTransfer' | 'adminIntervene') => {
    const resource = buttonResource(APPROVAL_INSTANCE_OBJECT, button, 'detail');
    if (!(await bound.authorize({ ...ctx, action: 'object.button', resource }))) return null;
    return memberInstanceScope(bound as TenantRouteDeps, ctx, tx);
  };
  const viewer = {
    userId: ctx.userId,
    transferScope: await adminScope('adminTransfer'),
    interveneScope: await adminScope('adminIntervene'),
  };
  const command = { ...ctx, now: bound.clock(), commandId: '', expectedRevision: 0 };
  try {
    return await readDetail(tx, command, instance.id, viewer, false);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export function contentViewFor(instance: InstanceRow | null, data: DetailData | null): ContentView {
  if (!instance || !data)
    return { mode: 'live', instanceId: instance?.id ?? null, taskId: null, round: null, actedAt: null };
  return contentViewOf(instance.id, data.content);
}

export interface ContentRead<Ext> {
  readonly instance: InstanceRow;
  readonly data: DetailData;
  /** 披露集：本查看人在本单上可见的业务字段名（三重交集）；undefined = 不受字段权限约束。 */
  readonly fields: ReadonlySet<string> | undefined;
  /** 已办读到的办理时披露上限（办理人当时可见的字段名）；null = 当时不受字段权限约束，或读现值。 */
  readonly ceiling: ReadonlySet<string> | null;
  /** 已办读到的办理份内容（ext 为各业务 provider 登记的扩展）；null = 读现值。 */
  readonly frozen: { readonly snapshot: BusinessSnapshot; readonly ext: Ext } | null;
  readonly contentView: ContentView;
}

/**
 * 按查看人选内容来源并算披露集；没有审批实例或打不开实例返回 null。
 * `objectCode`：字段权限所在对象（与办理时 `snapshot.fieldObjectCode` 同一个）。
 */
export async function openContentRead<Ext>(
  tx: Tx,
  deps: FrozenReadDeps,
  ctx: TenantContext,
  businessType: BusinessType,
  businessId: string,
  objectCode: string,
): Promise<ContentRead<Ext> | null> {
  const instance = await latestInstanceOf(tx, ctx.tenantId, businessType, businessId);
  if (!instance) return null;
  const data = await openApprovalDetail(tx, deps, ctx, instance);
  if (!data) return null;
  const inTx = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) } as TenantRouteDeps;
  const viewable = await getModuleViewableFieldsInTransaction(inTx, ctx, objectCode, tx);
  const fields = disclosedFields(data, ctx.userId, viewable);
  const contentView = contentViewFor(instance, data);
  if (data.content.mode === 'live') return { instance, data, fields, ceiling: null, frozen: null, contentView };
  const { ext } = data.content.frozen.content;
  // 办理份没有扩展内容（该类型尚未登记 ext）时无从还原申请详情：失败闭合，不退回现值
  if (ext === null || ext === undefined) throw new AppError('SERVICE_UNAVAILABLE', '办理记录暂不可读取，请稍后重试');
  const { ceiling } = data.content.frozen;
  return { instance, data, fields, ceiling, frozen: { snapshot: data.snapshot, ext: ext as Ext }, contentView };
}

/** 按披露集逐键裁剪一层嵌套对象（容器键内的字段名）；披露集 undefined = 不裁剪。 */
export function pickDisclosed(
  source: Readonly<Record<string, unknown>> | null | undefined,
  fields: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const entries = Object.entries(source ?? {});
  return Object.fromEntries(fields === undefined ? entries : entries.filter(([key]) => fields.has(key)));
}
