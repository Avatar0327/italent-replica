/** F-505 §3.3：两个人事来源场景仅支持四个通用变量。 */
import { and, eq, esignTemplates, inArray, isUuid, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { PersonVariableField } from './initiation.js';
import { ESIGN_TEMPLATE_LIMIT } from './service.js';

const COMMON_VARIABLES = new Set(['员工姓名', '工号', '发起日期', '企业名称']);
const variablesIn = (body: string) => Array.from(body.matchAll(/\{([^{}]*)\}/g), (match) => match[1]!);
const compatible = (body: string) => variablesIn(body).every((name) => COMMON_VARIABLES.has(name));

export async function sourceTemplateOptions(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({
      id: esignTemplates.id,
      name: esignTemplates.name,
      body: esignTemplates.body,
    })
    .from(esignTemplates)
    .where(and(eq(esignTemplates.tenantId, tenantId), eq(esignTemplates.status, 'enabled')))
    .orderBy(esignTemplates.sortOrder, esignTemplates.name, esignTemplates.id)
    .limit(ESIGN_TEMPLATE_LIMIT + 1);
  if (rows.length > ESIGN_TEMPLATE_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '签署模板超过单次处理上限');
  return { items: rows.filter((row) => compatible(row.body)).map(({ id, name }) => ({ id, name })) };
}

export function normalizeSourceTemplateIds(ids: readonly string[]) {
  if (ids.length < 1 || ids.length > 20 || ids.some((id) => !isUuid(id)))
    throw new AppError('VALIDATION_FAILED', '请选择 1 至 20 个签署模板');
  const normalized = ids.map((id) => id.toLowerCase()).sort();
  if (new Set(normalized).size !== normalized.length) throw new AppError('VALIDATION_FAILED', '签署模板不可重复');
  return normalized;
}

export async function lockSourceTemplates(tx: Tx, tenantId: string, ids: string[]) {
  // 锁与展示使用不同顺序：按 UUID 锁同一组行，按选项顺序生成快照。
  const locked = tx.$with('locked_esign_templates').as(
    tx
      .select()
      .from(esignTemplates)
      .where(and(eq(esignTemplates.tenantId, tenantId), inArray(esignTemplates.id, ids)))
      .orderBy(esignTemplates.id)
      .for('share'),
  );
  const templates = await tx.with(locked).select().from(locked).orderBy(locked.sortOrder, locked.name, locked.id);
  if (templates.length !== ids.length || templates.some((template) => template.status !== 'enabled'))
    throw new AppError('VALIDATION_FAILED', '签署模板不可用', { reason: 'ESIGN_TEMPLATE_UNAVAILABLE' });
  const variables = new Set(templates.flatMap(({ body }) => variablesIn(body)));
  if ([...variables].some((name) => !COMMON_VARIABLES.has(name)))
    throw new AppError('VALIDATION_FAILED', '签署模板含不适用变量', { reason: 'ESIGN_TEMPLATE_INCOMPATIBLE' });
  const fields: PersonVariableField[] = [];
  if (variables.has('员工姓名')) fields.push('name');
  if (variables.has('工号')) fields.push('code');
  return { templates, fields };
}
