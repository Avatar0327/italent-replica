/**
 * 计算规则审计里的“带出值”（F-082 契约 §5.3，DEC-376④、DEC-197）：日志按写入时的完整内容保存（删除快照、前后值都要能还原，
 * DEC-019），查询出口再按查看人**当前**的字段目录范围与 name / kind / enabled / systemWritten 四列查看权得到可见字段集合，
 * 对计算规则行的前后值、快照、差异做裁剪（领域层 redactCalcRuleAuditValue）：
 * - 新格式（规范文本，写入时存了历史名称）：可见引用按历史名称渲染，不可见的换成占位符，refFieldIds / fieldNames 去掉不可见的 ID；
 * - B5 旧格式（公式是名称文本）：按 legacy 规则，只有查看人可见字段里存在同名字段才原样显示。
 * 随 F082-2 合入即生效，同时认识新旧两种格式；新格式审计只在总开关打开后才会写出，所以 main 上任何中间状态都不会出现
 * “有新格式审计、无裁剪”。查看人没有 items 字段权限时整个 items 由原有字段级裁剪去掉（visibleValue / visibleChanges，不变）。
 */
import { redactCalcRuleAuditValue, TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { eq, talentReviewFields as F, type Tx } from '@italent/db';
import { requireConfigVisible } from '../modules/talent-review/access.js';
import { getModuleViewableFields, resolveModuleScope } from '../modules/permission/module-access.js';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import type { SourceRedactor } from './qualification-sources.js';

export const CALC_RULE_AUDIT_TYPE = TALENT_REVIEW_OBJECTS.calcRule.code;
const FIELD = TALENT_REVIEW_OBJECTS.field.code;
/** 引用盘点字段需要查看人对字段目录这四列的查看权（与计算规则接口一致）。 */
const REFERENCE_COLUMNS = ['name', 'kind', 'enabled', 'systemWritten'];

export async function calcRuleSources(deps: TenantRouteDeps, ctx: TenantContext): Promise<SourceRedactor> {
  const allowed = await deps.authorize({ ...ctx, action: 'object.view', resource: FIELD, fields: [] });
  const scope = allowed ? await resolveModuleScope(deps, ctx, undefined, FIELD) : null;
  const viewable = allowed ? await getModuleViewableFields(deps, ctx, FIELD) : undefined;
  const columns = allowed && (viewable === undefined || REFERENCE_COLUMNS.every((column) => viewable.has(column)));
  // hints 的投影随 items 列的查看权（契约 §5.2）；没有计算规则的对象查看权时 items 也看不到
  const ruleViewable = await getModuleViewableFields(deps, ctx, CALC_RULE_AUDIT_TYPE);
  const itemsViewable = ruleViewable === undefined || ruleViewable.has('items');
  return {
    async redact(tx: Tx, rows) {
      if (!rows.some((row) => row.objectType === CALC_RULE_AUDIT_TYPE)) return [...rows];
      const fields = await tx
        .select({ id: F.id, name: F.name, createdBy: F.createdBy })
        .from(F)
        .where(eq(F.tenantId, ctx.tenantId));
      const seen = scope && columns ? fields.filter((field) => visible(scope, field.createdBy)) : [];
      const directory = {
        visible: new Map(seen.map((field) => [field.id.toLowerCase(), field.name])),
        allVisible: seen.length === fields.length,
        itemsViewable,
      };
      return rows.map((row) =>
        row.objectType === CALC_RULE_AUDIT_TYPE
          ? {
              ...row,
              before: redactCalcRuleAuditValue(row.before, directory),
              after: redactCalcRuleAuditValue(row.after, directory),
              changes: redactCalcRuleAuditValue(row.changes, directory),
            }
          : row,
      );
    },
  };
}

function visible(scope: NonNullable<Awaited<ReturnType<typeof resolveModuleScope>>>, createdBy: string | null) {
  try {
    requireConfigVisible(scope, 'field', createdBy);
    return true;
  } catch {
    return false;
  }
}
