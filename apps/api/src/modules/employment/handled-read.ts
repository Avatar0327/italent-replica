/**
 * 考核 / 意向退休申请的“已办读取”共用件（F-476 P7，设计 §5.3、§6.0）。
 * - 办理时冻结的是业务内容（ext = 表单字段取值）；状态、版本号、生成的转正业务编号等流程事实始终读现值，不进办理份。
 * - 候选实例取该业务单的**全部**审批实例（最新的优先）：被驳回 / 不同意后业务单可能不再指向某个实例，不能只看“当前实例”。
 * - 已办读取只留披露集合（办理时上限 ∩ 办理节点表单 ∩ 当前字段权限）内的内容键；办理份缺失 / 内容残缺一律 503，
 *   不退回现值（DEC-807）。调用方已通过原有的人事读权限与数据范围，这里只决定“读哪一份内容”。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import type { BusinessType } from '../approval/adapters.js';
import { approvalError, rowsOf } from '../approval/context.js';
import { disclosedFields, readDetail, type DetailData } from '../approval/disclosure.js';
import { foreignVisibility, viewableWithForeign } from '../approval/foreign-fields.js';
import { contentViewOf } from '../approval/handling-content.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';

type Row = Record<string, unknown>;

export interface HandledRead {
  readonly contentView: ReturnType<typeof contentViewOf> | { mode: 'live'; instanceId: null };
  /** 已办读取：冻结的内容键值与披露集合；现值读取为 null。 */
  readonly frozen: { readonly ext: unknown; readonly allowed: ReadonlySet<string> } | null;
}

const LIVE: HandledRead = { contentView: { mode: 'live', instanceId: null }, frozen: null };

/** 该业务单的全部审批实例（最新在前）；驳回后重提复用同一实例，取消后重新发起则有多个。 */
async function instancesOf(tx: Tx, tenantId: string, type: BusinessType, businessId: string): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id::text AS id FROM approval_instances
      WHERE tenant_id=${tenantId} AND business_type=${type} AND business_id=${businessId}::uuid
      ORDER BY created_at DESC, id DESC`),
  );
  return rows.map((row) => row.id);
}

/**
 * 以参与人身份打开实例，只为决定内容来源：不带管理员范围——纯管理员没有办理记录，本来就读现值；
 * 打不开（不是参与人）返回 null。
 */
async function openAsParticipant(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  instanceId: string,
): Promise<DetailData | null> {
  const viewer = { userId: ctx.userId, transferScope: null, interveneScope: null };
  try {
    return await readDetail(tx, { ...ctx, now, commandId: '', expectedRevision: 0 }, instanceId, viewer, false);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

const pendingFor = (data: DetailData, userId: string): boolean =>
  data.allTasks.some((task) => task.assigneeUserId === userId && task.status === 'pending');

/**
 * 选内容来源：发起人 / 本人有待办 → 现值；否则取本人最近一次办理的冻结份（缺份 503）；没办理过 → 现值。
 * 最新实例优先：新实例里本人仍有待办时，不让旧实例的已办份盖过现值。
 */
export async function selectHandledRead(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  type: BusinessType,
  businessId: string,
): Promise<HandledRead> {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    for (const instanceId of await instancesOf(tx, ctx.tenantId, type, businessId)) {
      const data = await openAsParticipant(tx, ctx, deps.clock(), instanceId);
      if (!data) continue;
      // 发起人 / 本人仍有待办：现值（旧实例的已办份不得盖过它）
      if (data.instance.initiatorUserId === ctx.userId || pendingFor(data, ctx.userId))
        return { contentView: contentViewOf(instanceId, { mode: 'live' }), frozen: null };
      if (data.content.mode === 'live') continue;
      const ext = data.content.frozen.content.ext;
      const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
      const own = await getModuleViewableFieldsInTransaction(bound, ctx, data.snapshot.fieldObjectCode, tx);
      const viewable = await viewableWithForeign(data.snapshot, own, foreignVisibility(bound, ctx, tx));
      return {
        contentView: contentViewOf(instanceId, data.content),
        frozen: { ext, allowed: disclosedFields(data, ctx.userId, viewable) },
      };
    }
    return LIVE;
  });
}

/** 办理份里的内容扩展必须是含全部内容键的对象；缺扩展 / 残缺按缺份处理，失败闭合（DEC-807、DEC-402 不做旧数据兼容）。 */
export function requireExt(ext: unknown, keys: readonly string[]): Row {
  if (ext && typeof ext === 'object' && keys.every((key) => Object.hasOwn(ext, key))) return ext as Row;
  throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
}

/** 已办读取的组合：现值只留流程事实，业务内容全部取自冻结份且只留披露集合内的键。 */
export function composeHandled(live: object, frozen: Row, facts: readonly string[], allowed: ReadonlySet<string>): Row {
  const result = Object.fromEntries(Object.entries(live as Row).filter(([key]) => facts.includes(key)));
  for (const [key, value] of Object.entries(frozen)) if (allowed.has(key)) result[key] = value;
  return result;
}

/** 取行里的内容键（办理时写入 ext）。 */
export const pickContent = (row: object, keys: readonly string[]): Row =>
  Object.fromEntries(keys.map((key) => [key, (row as Row)[key] ?? null]));
