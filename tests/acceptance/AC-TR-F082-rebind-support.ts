/**
 * F-082（F082-5）改绑验收夹具：
 * - 存量 legacy 数据由“开关关闭”的 B5 写入路径产生（同一个库同一个租户，换一个开关打开的应用实例做改绑与读取）；
 * - 解析不了的公式（未知 / 重名 / 裸词 / 整段解析失败）B5 的接口写不进去，测试直接改库里的公式文本（模拟升级前的存量）；
 * - 改绑经平台接口 POST /api/platform/tenants/:tenantId/talent-review/calc-formulas/rebind。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { CALC_RULES, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { calcBody, calcItem, calcWorld, type F082World, type FieldRef } from './AC-TR-F082-support.js';
import { PLATFORM, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const clock = () => TR_NOW;
export const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export interface RebindReport {
  rules: number;
  bound: number;
  unresolved: { ruleId: string; targetFieldId: string; reason: string }[];
}

/** B5（开关关闭）建数据的世界 + 开关打开的实例 + 平台运营身份。 */
export async function rebindWorld(db: Db, label: string, deps: { clock?: () => Date } = {}) {
  const w = await calcWorld(db, label, { formulaIdBinding: false });
  const on = tenantApi(db, { clock: deps.clock ?? clock, formulaIdBinding: true });
  const operator = await seedOperator(db, `rebind-${label}`);
  const tenantId = w.as.tenant;

  const rebind = (body: object = {}, idempotencyKey: string = randomUUID()) =>
    on.request('POST', `${PLATFORM}/tenants/${tenantId}/talent-review/calc-formulas/rebind`, {
      user: operator.id,
      body,
      idempotencyKey,
    });
  const runRebind = async (body: object = {}) => {
    const response = await rebind(body);
    if (response.status !== 200) throw new Error(`改绑失败：${response.status} ${await response.text()}`);
    return (await response.json()) as RebindReport;
  };
  /** 开关打开的实例上读规则（渲染后的对外表示）。 */
  const readOn = async (id: string) => {
    const response = await on.request('GET', `${TR_BASE}${CALC_RULES}/${id}`, { ...w.as });
    return { status: response.status, body: (await response.json()) as CalcRuleView };
  };
  const requestOn = (method: string, path: string, options: Parameters<typeof on.request>[2] = {}) =>
    on.request(method, `${TR_BASE}${path}`, { ...w.as, ...options });
  return { ...w, db, on, operator, tenantId, rebind, runRebind, readOn, requestOn };
}
export type RebindWorld = Awaited<ReturnType<typeof rebindWorld>>;

/** 一条 B5 规则，每个目标字段一个项目；返回规则与各项目的 ID（按目标字段）。 */
export async function legacyRule(w: RebindWorld, items: readonly { target: FieldRef; formula: string }[]) {
  const rule = await w.create(calcBody(items.map((item) => calcItem(item.target, item.formula))));
  const ids = new Map<string, string>();
  for (const item of items) ids.set(item.target.id, await itemId(w, rule.id, item.target.id));
  return { rule, itemOf: (target: FieldRef) => ids.get(target.id)! };
}

export async function itemId(w: Pick<RebindWorld, 'db' | 'tenantId'>, ruleId: string, targetFieldId: string) {
  const found = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT id FROM talent_review_calc_rule_items WHERE rule_id = ${ruleId}
      AND target_field_id = ${targetFieldId}`),
  );
  return rows<{ id: string }>(found)[0]!.id;
}

/** 直接改库里的公式文本（模拟升级前 B5 存下的、新规则解析不了的存量）。 */
export async function setFormulaText(w: Pick<RebindWorld, 'db' | 'tenantId'>, id: string, formula: string) {
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`UPDATE talent_review_calc_rule_items SET formula = ${formula} WHERE id = ${id}`),
  );
}

export interface RawItem {
  formula: string;
  formula_binding: string;
  binding_issue: string | null;
}
export async function rawItemOf(w: Pick<RebindWorld, 'db' | 'tenantId'>, id: string): Promise<RawItem> {
  const found = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT formula, formula_binding, binding_issue FROM talent_review_calc_rule_items WHERE id = ${id}`),
  );
  return rows<RawItem>(found)[0]!;
}

export async function refsFor(w: Pick<RebindWorld, 'db' | 'tenantId'>, id: string) {
  const found = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT field_id, kind FROM talent_review_calc_item_refs WHERE item_id = ${id}
      ORDER BY kind, field_id`),
  );
  return rows<{ field_id: string; kind: string }>(found);
}

export async function auditCount(w: Pick<RebindWorld, 'db' | 'tenantId'>, action: string, objectId?: string) {
  const found = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}
      ${objectId ? sql`AND object_id = ${objectId}` : sql``}`),
  );
  return Number(rows<{ n: number }>(found)[0]!.n);
}

export const REBIND_ACTION = 'talent-review.calc-rule.rebind';
export type { F082World };
