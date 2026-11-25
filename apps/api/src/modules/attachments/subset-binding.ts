/**
 * F-479 §10.4 子集附件绑定函数：人员子集记录与附件的唯一关联出口，在 saveSubset 内与子集写、审计、outbox、命令台账同一事务调用。
 * - 新出现的文件 ID（保存后 − 保存前）：必须是当前操作人上传、目标员工名下、状态 uploaded 且未过期，才转 bound；
 * - 不再出现的文件 ID（保存前 − 保存后，删除记录时保存后为空）：仍绑定在本记录的转 pending_cleanup，字节由清理任务释放；
 * - 未变的 ID 不动、不校验（DEC-402：历史值不做老数据兼容）。
 * 不满足一律 400 ATTACHMENT_INVALID，错误体只回显字段名，不回显文件任何元数据。
 */
import { type Tx } from '@italent/db';
import { subsetAttachmentFields, type SubsetKind } from '@italent/domain';
import { AppError } from '../../errors.js';
import { lockFiles, move, type BindingContext } from './binding.js';
import { SUBSET_BUSINESS_TYPE, SUBSET_PURPOSE } from './subset-read.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string) => new AppError('ATTACHMENT_INVALID', `附件不可用，请重新上传：${field}`, { field });

type Values = Readonly<Record<string, unknown>>;
/** 附件字段 → 小写文件 ID；空值与非字符串不算引用（格式校验在 added 里做）。 */
function refsOf(kind: SubsetKind, values: Values | null): Map<string, string> {
  const refs = new Map<string, string>();
  for (const field of subsetAttachmentFields(kind)) {
    const value = values?.[field];
    if (typeof value === 'string') refs.set(value.toLowerCase(), field);
  }
  return refs;
}

/**
 * DEC-937：非 HR 来源（员工自助、信息采集、同步、初始化、评估）不得新增 / 更换 / 清空 / 互换附件引用。
 * 唯一判定入口：提交、同单重提、落地（bindSubsetAttachments）都调它，按**字段**比较保存前后引用，
 * 不按文件集合（集合不变、字段改变的互换 / 复填同样是变更）。after 是应用后的完整值，删除记录传 null。
 */
export const attachmentRefsLocked = () =>
  new AppError('FORBIDDEN', '附件只能由人事在人员档案里维护，不能通过该来源变更');
const refOf = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : null);
export function assertNoAttachmentRefChange(
  source: { readonly type: string },
  kind: SubsetKind,
  before: Values | null,
  after: Values | null,
) {
  if (source.type === 'hr_direct') return;
  for (const field of subsetAttachmentFields(kind)) {
    if (refOf(after?.[field]) !== refOf(before?.[field])) throw attachmentRefsLocked();
  }
}

export interface SubsetBindInput {
  readonly kind: SubsetKind;
  /** 保存来源；只有 hr_direct 可以变更附件引用。 */
  readonly source: { readonly type: string };
  readonly employeeId: string;
  readonly recordId: string;
  readonly previous: Values | null;
  /** 保存后的值；删除记录时为 null。 */
  readonly next: Values | null;
}

export async function bindSubsetAttachments(tx: Tx, ctx: BindingContext, input: SubsetBindInput): Promise<void> {
  // 先按字段判来源，再按文件集合做 HR 的绑定 / 清理：集合判定只决定哪些文件要转状态，不决定能否变更
  assertNoAttachmentRefChange(input.source, input.kind, input.previous, input.next);
  const previous = refsOf(input.kind, input.previous);
  const next = refsOf(input.kind, input.next);
  const added = [...next].filter(([id]) => !previous.has(id));
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  if (!added.length && !removed.length) return;
  for (const [id, field] of added) if (!UUID.test(id)) throw invalid(field);
  const files = await lockFiles(
    tx,
    ctx.tenantId,
    [...added.map(([id]) => id), ...removed].filter((id) => UUID.test(id)),
  );
  const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  for (const [id, field] of added) {
    const row = files.get(id);
    const fresh =
      row?.purpose === SUBSET_PURPOSE &&
      row.status === 'uploaded' &&
      same(row.ownerUserId, ctx.userId) &&
      same(row.ownerEmployeeId, input.employeeId) &&
      (!row.expiresAt || row.expiresAt > ctx.now);
    if (!fresh) throw invalid(field);
    await move(tx, ctx, row, 'bind', {
      status: 'bound',
      businessType: SUBSET_BUSINESS_TYPE,
      businessId: input.recordId,
      expiresAt: null,
    });
  }
  for (const id of removed) {
    const row = files.get(id);
    const owned =
      row?.status === 'bound' && row.businessType === SUBSET_BUSINESS_TYPE && same(row.businessId, input.recordId);
    if (owned) await move(tx, ctx, row, 'unbind', { status: 'pending_cleanup', cleanupAt: ctx.now });
  }
}

/**
 * 16a-2c 受信撤回契约（设计 §4.1 第 7 条）：撤回删行时解除该记录的全部附件绑定，转 pending_cleanup。
 * 只解绑，不新增 / 更换引用，所以不走 DEC-937 的来源校验；候选人侧仍不能直接写附件引用。
 */
export async function unbindSubsetAttachments(
  tx: Tx,
  ctx: BindingContext,
  kind: SubsetKind,
  recordId: string,
  previous: Values | null,
): Promise<void> {
  const ids = [...refsOf(kind, previous).keys()].filter((id) => UUID.test(id));
  if (!ids.length) return;
  const files = await lockFiles(tx, ctx.tenantId, ids);
  for (const id of ids) {
    const row = files.get(id);
    const owned =
      row?.status === 'bound' &&
      row.businessType === SUBSET_BUSINESS_TYPE &&
      row.businessId?.toLowerCase() === recordId.toLowerCase();
    if (owned) await move(tx, ctx, row, 'unbind', { status: 'pending_cleanup', cleanupAt: ctx.now });
  }
}
