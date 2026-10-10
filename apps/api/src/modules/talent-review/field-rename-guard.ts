/**
 * 字段改名守卫（F-082 契约 §3.1，DEC-376②⑤⑥）。公式存的是字段 ID，改名不写计算规则数据（规则 revision 不变，下次读取显示新名称，
 * 允许改成与其他字段同名）；守卫保证两件事：
 * - 引用它的每个 bound 公式按新名称渲染后仍能原样重提（完整往返：长度、词数、语法、逐引用映射），否则 409
 *   FIELD_NAME_BREAKS_FORMULA，什么都不写；全租户的改名在字段目录版本行上串行，所以“各自通过、合计超限”不会发生；
 * - 文本兜底（非 bound 公式按名称文本引用）命中的关系在改名前固化成按 ID 的候选引用，改名消除不了删除保护。
 * 锁序（§3.4）：调用方已持字段行 FOR UPDATE（F）→ 版本行 FOR UPDATE（V）→ 读取 → 计算项目行 KEY SHARE（I）。
 */
import { eq, sql, talentReviewFields as F, type Tx } from '@italent/db';
import { checkRenameRoundTrip, type RenameBreakReason } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireConfigVisible, type ModuleScope } from './access.js';
import type { WriteContext } from './config-kit.js';
import { lockFieldCatalog } from './field-catalog.js';
import { textFallbackItems } from './text-fallback.js';

/** 改名操作人对计算规则的披露权限（契约 §3.1“错误载荷不披露看不到的项目”）：CalcRule 查看权 + 范围 + items 列查看权。 */
export interface CalcDisclosure {
  readonly scope: ModuleScope;
  readonly itemsViewable: boolean;
}
export interface FieldWriteContext extends WriteContext {
  /** 没有 CalcRule 查看权时为空——所有受影响的项目都只计入匿名计数。 */
  readonly calcDisclosure?: CalcDisclosure | undefined;
  /**
   * 改名操作人对字段目录 name / kind / enabled / systemWritten 四列的查看权（引用盘点字段所需，与计算规则接口、审计裁剪同一口径）。
   * 缺省按没有处理（fail-closed）：目标字段只计入匿名计数。
   */
  readonly fieldColumnsViewable?: boolean | undefined;
}

export interface BrokenItem {
  readonly ruleId: string;
  readonly targetFieldId: string;
  readonly reason: RenameBreakReason;
  readonly ruleCreatedBy: string | null;
  readonly targetCreatedBy: string | null;
}
export interface BreaksPayload {
  readonly affected: readonly { ruleId: string; targetFieldId: string; reason: RenameBreakReason }[];
  readonly others: number;
}

const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const visibleTo = (scope: ModuleScope, object: 'calcRule' | 'field', createdBy: string | null) => {
  try {
    requireConfigVisible(scope, object, createdBy);
    return true;
  } catch {
    return false;
  }
};

/**
 * 受影响项目的披露分区：同时满足（有 CalcRule 查看权且规则在其范围内）、（有 items 列查看权）、（目标字段在其字段目录中可见：
 * 范围 + 四列查看权，R1-P2-3）才列入 affected（带原因类别），否则只计入匿名的 others，不给规则 ID、目标字段 ID 与原因（DEC-376①）。
 */
export function partitionBroken(
  broken: readonly BrokenItem[],
  disclosure: CalcDisclosure | undefined,
  fieldScope: ModuleScope,
  fieldColumnsViewable: boolean | undefined,
): BreaksPayload {
  const affected: BreaksPayload['affected'][number][] = [];
  let others = 0;
  for (const item of broken) {
    const shown =
      disclosure !== undefined &&
      disclosure.itemsViewable &&
      fieldColumnsViewable === true &&
      visibleTo(disclosure.scope, 'calcRule', item.ruleCreatedBy) &&
      visibleTo(fieldScope, 'field', item.targetCreatedBy);
    if (shown) affected.push({ ruleId: item.ruleId, targetFieldId: item.targetFieldId, reason: item.reason });
    else others += 1;
  }
  return { affected, others };
}

const breaksMessage = ({ affected, others }: BreaksPayload) =>
  affected.length === 0
    ? `改名会使 ${others} 个你无权查看的计算公式无法保存`
    : `改名会使 ${affected.length} 个计算公式无法保存${others > 0 ? `（另有 ${others} 个你无权查看）` : ''}`;

interface BoundRow {
  readonly id: string;
  readonly rule_id: string;
  readonly target_field_id: string;
  readonly formula: string;
  readonly rule_created_by: string | null;
  readonly target_created_by: string | null;
}

/** 引用该字段的全部 bound 项目（引用表 kind = 'bound'），连同规则与目标字段的创建人（披露范围判定用）。 */
async function boundItemsReferencing(tx: Tx, tenantId: string, fieldId: string): Promise<BoundRow[]> {
  return rowsOf<BoundRow>(
    await tx.execute(sql`
      SELECT i.id, i.rule_id, i.target_field_id, i.formula,
             k.created_by AS rule_created_by, tf.created_by AS target_created_by
        FROM talent_review_calc_item_refs r
        JOIN talent_review_calc_rule_items i ON i.tenant_id = r.tenant_id AND i.id = r.item_id
        JOIN talent_review_calc_rules k ON k.tenant_id = i.tenant_id AND k.id = i.rule_id
        JOIN talent_review_fields tf ON tf.tenant_id = i.tenant_id AND tf.id = i.target_field_id
       WHERE r.tenant_id = ${tenantId}::uuid AND r.field_id = ${fieldId}::uuid
         AND r.kind = 'bound' AND i.formula_binding = 'bound'
       ORDER BY i.id`),
  );
}

/**
 * 第 5 步：为这些项目补写 (项目, 本字段, 'candidate') 引用（已有则跳过）。写入前先对项目行 SELECT … FOR KEY SHARE
 * （等待，不跳过）：项目若正被删除（规则删除级联），等对方提交后读不到该行，就不再插入、不会撞外键；
 * 对方回滚则锁住后照常插入。这是锁序里 V 之后取 I，不新增反向等待。
 */
async function solidifyCandidates(
  tx: Tx,
  tenantId: string,
  fieldId: string,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const ids = sql.join(
    itemIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const alive = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM talent_review_calc_rule_items
      WHERE tenant_id = ${tenantId}::uuid AND id IN (${ids}) ORDER BY id FOR KEY SHARE`),
  );
  for (const { id } of alive) {
    await tx.execute(sql`INSERT INTO talent_review_calc_item_refs (tenant_id, item_id, field_id, kind)
      VALUES (${tenantId}::uuid, ${id}::uuid, ${fieldId}::uuid, 'candidate') ON CONFLICT DO NOTHING`);
  }
}

export async function guardFieldRename(
  tx: Tx,
  ctx: FieldWriteContext,
  fieldId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  // 2. 字段目录版本行 FOR UPDATE：全租户的新建、改名、删除在这一行上串行
  await lockFieldCatalog(tx, ctx.tenantId);
  // 3. 在持有版本行之后读取：引用该字段的 bound 项目与其余字段的当前名称（本字段按新名称）
  const bound = await boundItemsReferencing(tx, ctx.tenantId, fieldId);
  if (bound.length > 0) {
    const names = await tx.select({ id: F.id, name: F.name }).from(F).where(eq(F.tenantId, ctx.tenantId));
    const renamed = names.map((field) => (field.id === fieldId ? { id: field.id, name: newName } : field));
    // 4. 完整往返
    const broken: BrokenItem[] = [];
    for (const item of bound) {
      const result = checkRenameRoundTrip(item.formula, renamed);
      if (result.ok) continue;
      broken.push({
        ruleId: item.rule_id,
        targetFieldId: item.target_field_id,
        reason: result.reason,
        ruleCreatedBy: item.rule_created_by,
        targetCreatedBy: item.target_created_by,
      });
    }
    if (broken.length > 0) {
      const payload = partitionBroken(broken, ctx.calcDisclosure, ctx.scope, ctx.fieldColumnsViewable);
      throw new AppError('CONFLICT', breaksMessage(payload), { reason: 'FIELD_NAME_BREAKS_FORMULA', ...payload });
    }
  }
  // 5. 固化文本兜底
  await solidifyCandidates(tx, ctx.tenantId, fieldId, await textFallbackItems(tx, ctx.tenantId, oldName));
}
