/** 设计 §2.3 / DEC-436：复制冻结内容，复用保存入口的来源锁序与模块 ID 绑定迁移。 */
import { and, eq, inArray, talentCriteria, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { buildPlan, checkTemplateReferences, type TemplateWriteContext } from './template-structure.js';
import type { TemplateView } from './template-view.js';

const ids = (values: readonly (string | null)[]) => [...new Set(values.filter((id): id is string => !!id))];
export function copyReferences(source: TemplateView) {
  return {
    flow: [],
    form: [],
    scoreRule: ids(source.modules.map((m) => m.scoreRuleId)),
    moduleGrade: ids(source.modules.map((m) => m.moduleGradeId)),
    field: ids([
      ...source.modules.flatMap((m) => m.fieldIds),
      ...source.resultRules.flatMap((r) => [r.targetFieldId, ...r.refFieldIds]),
    ]),
  };
}

export async function copyPlan(tx: Tx, ctx: TemplateWriteContext, source: TemplateView) {
  const plan = await buildPlan(
    tx,
    ctx,
    { flowId: source.flowId, structure: source },
    {
      flowId: null,
      steps: [],
      permissions: [],
      stepForms: [],
    },
  );
  // 新模板是新增引用：冻结内容原样复制，但不能借原模板继续持有的资格新增停用来源的引用（设计 §7）。
  // buildPlan 已按 来源配置 → 字段 → 目录版本 取锁，此处只读复核，不在目录锁后补来源锁。
  const references = copyReferences(source);
  for (const kind of ['scoreRule', 'moduleGrade', 'field'] as const)
    await checkTemplateReferences(tx, ctx, kind, references[kind], new Set(), false);
  const criteria = ids(source.modules.map((m) => m.criterionId));
  if (criteria.length) {
    const rows = await tx
      .select({ id: talentCriteria.id, enabled: talentCriteria.enabled })
      .from(talentCriteria)
      .where(and(eq(talentCriteria.tenantId, ctx.tenantId), inArray(talentCriteria.id, criteria)));
    if (rows.length !== criteria.length || rows.some((r) => !r.enabled))
      throw new AppError('VALIDATION_FAILED', '人才标准不存在或已停用，不能引用', {
        reason: 'CRITERION_NOT_REFERENCEABLE',
      });
  }
  // 公式引用已按旧 → 新 ID 迁移；复制件的版本链从自己开始，不能留下指向原件的模块祖先。
  return { ...plan, modules: plan.modules.map((m) => ({ ...m, previousModuleId: null })) };
}
