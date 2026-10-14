/**
 * F-082 总开关 formulaIdBinding（契约 §10，DEC-381）：计算公式字段引用按 ID 绑定的
 * 新写入路径（规范文本、引用表）、新响应字段、新格式审计、改绑路由都挂在它下面。
 * 默认值只在这里定义：F082-1 起为 false，最后一个 PR（F082-5）改为 true——开关打开才是 F-082 的最终形态。
 * 保护类改动（删除守卫、改名守卫与候选固化、版本接线与锁序、审计读取裁剪）不受开关控制。
 *
 * 不做启用标记或运行时新旧实例互斥（DEC-386）：首次启用的约束只在部署手册与只读检查脚本里（F082-5）。
 */
import { type Db, isIsolatedTestDb } from '@italent/db';

export const FORMULA_ID_BINDING_DEFAULT = true;

/** 开关取值：不覆盖时是默认值；覆盖只允许作用于 useTestDb() 建的隔离测试库，否则抛错（打开或关闭都一样）。 */
export function resolveFormulaIdBinding(deps: {
  readonly db?: Db | undefined;
  readonly formulaIdBinding?: boolean;
}): boolean {
  if (deps.formulaIdBinding === undefined) return FORMULA_ID_BINDING_DEFAULT;
  if (!deps.db || !isIsolatedTestDb(deps.db)) {
    throw new Error('formulaIdBinding 开关覆盖只允许作用于 useTestDb() 建的隔离测试库');
  }
  return deps.formulaIdBinding;
}
