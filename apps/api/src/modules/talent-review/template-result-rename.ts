/** 字段改名不能破坏历史模板公式的可读回 / 可重提性（F-082 §3.1、DEC-387）。 */
import {
  and,
  eq,
  inArray,
  type Tx,
  talentReviewTemplateResultRules as R,
  talentReviewTemplateResultRefs as RF,
  talentReviewTemplateModules as M,
} from '@italent/db';
import { checkRenameRoundTrip } from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadFullCatalog } from './calc-rule-catalog.js';
import { moduleFields } from './template-results.js';

export async function guardTemplateResultRename(tx: Tx, tenantId: string, fieldId: string, name: string) {
  // 调用方已持有字段行和目录版本行锁；只读不可变版本，避免逆序锁模板。
  const rules = await tx
    .select({ formula: R.formula, versionId: R.versionId })
    .from(R)
    .innerJoin(RF, and(eq(RF.tenantId, R.tenantId), eq(RF.ruleId, R.id)))
    .where(and(eq(R.tenantId, tenantId), eq(RF.fieldId, fieldId)));
  if (!rules.length) return;
  const names = (await loadFullCatalog(tx, tenantId)).map((f) => (f.id === fieldId ? { ...f, name } : f));
  const modules = await tx
    .select()
    .from(M)
    .where(and(eq(M.tenantId, tenantId), inArray(M.versionId, [...new Set(rules.map((r) => r.versionId))])));
  for (const rule of rules) {
    const fields = moduleFields(modules.filter((m) => m.versionId === rule.versionId));
    if (!checkRenameRoundTrip(rule.formula, names, (path) => Object.hasOwn(fields, path)).ok) {
      throw new AppError('CONFLICT', '该名称会使已引用的公式无法原样重提', { reason: 'FIELD_NAME_BREAKS_FORMULA' });
    }
  }
}
