/**
 * F-474-8c-3n P2-1 / F-476 §3.3：社保标签在办理事务中捕获到任职 ext，来源字段同时充当披露权限键。
 * 沿 Offer refs 的做法：已办只投影冻结标签，未捕获到的标签以 null 占位，禁止读取时用现名补齐。
 */
import type { Tx } from '@italent/db';
import type { BusinessSnapshot } from '../approval/adapters.js';
import { approvalError, type Row } from '../approval/context.js';
import type { FrozenContent } from '../approval/handling-content.js';
import { insuranceReferenceNames } from './reference-names.js';

// 封闭的标签白名单；不序列化整份表单 / 响应，不引入条件值、动作或其它引用对象。
const REFERENCES = [
  ['adjustedInsurancePlanId', 'plans'],
  ['adjustedInsuranceCompanyId', 'companies'],
  ['insuranceOrigin.planId', 'plans'],
  ['insuranceOrigin.companyId', 'companies'],
] as const;
type Source = (typeof REFERENCES)[number][0];
export type InsuranceRefs = Partial<Record<`${Source}Name`, string | null>>;
const hasId = (values: Readonly<Row>, source: string) => typeof values[source] === 'string' && !!values[source];
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function captureInsuranceRefs(
  tx: Tx,
  tenantId: string,
  snapshot: BusinessSnapshot,
  viewable: ReadonlySet<string> | undefined,
): Promise<InsuranceRefs> {
  // viewable 已经过 viewableWithForeign：原值按社保档案对象及字段权限，而非任职字段目录。
  const visible = REFERENCES.filter(
    ([source]) => (!viewable || viewable.has(source)) && hasId(snapshot.values, source),
  );
  const ids = (kind: 'plans' | 'companies') =>
    new Set(visible.filter(([, type]) => type === kind).map(([source]) => snapshot.values[source] as string));
  const names = await insuranceReferenceNames(tx, tenantId, snapshot.businessDate, ids('plans'), ids('companies'));
  return Object.fromEntries(
    visible.map(([source, kind]) => [`${source}Name`, names[kind].get(snapshot.values[source] as string) ?? null]),
  );
}

export function projectInsuranceValues(frozen: FrozenContent, values: Row, disclosed: ReadonlySet<string>): Row {
  if (!REFERENCES.some(([source]) => hasId(frozen.content.snapshot.values, source))) return values;
  const ext = frozen.content.ext;
  // 沿 F-476 的缺份失败闭合：有社保引用却缺少整块标签材料，不允许回退到现值。
  if (!isRow(ext) || !isRow(ext.insuranceRefs))
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
  const result = { ...values };
  for (const [source] of REFERENCES) {
    const key = `${source}Name`;
    if (disclosed.has(source) && hasId(values, source)) result[key] = ext.insuranceRefs[key] ?? null;
    else delete result[key];
  }
  return result;
}
