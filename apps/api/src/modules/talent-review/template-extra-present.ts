/** 详情 / 写响应 / 重放统一按当前字段目录渲染；hints 随 resultRules 查看权投影（F-082 §5.2）。 */
import { withTenant, type Tx } from '@italent/db';
import { parseFieldHandle, projectHints, renderFormula, FORMULA_REPAIR_NOTICE } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { codeOf, type TalentReviewContext } from './access.js';
import {
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScope,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { loadFullCatalog, visibleOf, type CatalogAccess } from './calc-rule-catalog.js';
import { readFieldCatalogVersion } from './field-catalog.js';
import { analyzeResults, moduleFields } from './template-results.js';
import type { TemplateView } from './template-view.js';

export async function resultCatalogAccess(
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  tx?: Tx,
): Promise<CatalogAccess | undefined> {
  const resource = codeOf('field');
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource, fields: [] }))) return undefined;
  const scope = tx
    ? await resolveModuleScopeInTransaction(deps, ctx, tx, resource)
    : await resolveModuleScope(deps, ctx, undefined, resource);
  const fields = tx
    ? await getModuleViewableFieldsInTransaction(deps, ctx, resource, tx)
    : await getModuleViewableFields(deps, ctx, resource);
  return {
    scope,
    columns: fields === undefined || ['name', 'kind', 'enabled', 'systemWritten'].every((k) => fields.has(k)),
  };
}

export async function projectTemplateResults<T extends Omit<TemplateView, 'versionId'>>(
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  view: T,
) {
  const access = await resultCatalogAccess(deps, ctx);
  const columns = await getModuleViewableFields(deps, ctx, codeOf('template'));
  const can = (key: string) => columns === undefined || columns.has(key);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const full = await loadFullCatalog(tx, ctx.tenantId);
    const visible = visibleOf(full, access);
    const ids = new Set(visible.map((f) => f.id));
    const fields = moduleFields(view.modules);
    const analysis = analyzeResults(view.resultRules, full, view.modules);
    const raw = analysis.ok
      ? { ...analysis.hints, diagnostics: analysis.diagnostics }
      : { order: view.resultRules.map((r) => r.targetFieldId), blocked: [], cycles: [], diagnostics: [] };
    const hints = projectHints(raw, {
      itemsViewable: can('resultRules'),
      target: (id) => ids.has(id),
      shown: (key) => (Object.hasOwn(fields, key) ? can('modules') : ids.has(parseFieldHandle(key) ?? '')),
    });
    const resultRules = view.resultRules.map((row) => {
      const rendered = renderFormula(row.formula, { binding: 'bound', visibleFields: visible });
      return {
        targetFieldId: ids.has(row.targetFieldId) ? row.targetFieldId : null,
        priority: row.priority,
        formula: rendered.ok ? rendered.text : FORMULA_REPAIR_NOTICE,
        formulaBindings: rendered.ok ? [...rendered.bindings] : [],
      };
    });
    return { ...view, resultRules, hints, fieldCatalogVersion: await readFieldCatalogVersion(tx, ctx.tenantId) };
  });
}

/** 字段目录版本是输入协议，不是模板业务字段。 */
export function templateBusinessFields<T extends { fieldCatalogVersion?: number | undefined }>(input: T) {
  const { fieldCatalogVersion: _version, ...fields } = input;
  return fields;
}
