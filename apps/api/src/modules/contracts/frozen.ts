/**
 * 合同申请详情的冻结读（F-476 P5，docs/08_设计/F-476_审批办理时冻结快照_设计.md §5.4）。
 * 办理份 ext = 办理时的合同申请整行；已办读取时按披露集（办理时上限 ∩ 办理节点表单 ∩ 当前字段权限）逐键裁剪，
 * 容器键（submittedFields / customFields）裁到内部字段名——只裁顶层会让撤权后的值从容器里漏出。
 */
import type { Tx } from '@italent/db';
import { CONTRACT_FIELDS } from '@italent/domain';
import { pickDisclosed } from '../approval/frozen-read.js';
import { loadRequest, type ContractRequest } from './service.js';

/** 办理份 provider：办理时（业务状态尚未被本次办理推进）的合同申请行。 */
export const loadContractContent = (tx: Tx, tenantId: string, id: string): Promise<ContractRequest> =>
  loadRequest(tx, tenantId, id);

const BUSINESS_KEYS = new Set<string>([...CONTRACT_FIELDS, 'customFields', 'submittedFields']);

/**
 * 申请详情响应的投影契约（F-476 P5 R1 P2-2）。`viewable`：当前合同对象字段权限，决定非业务键（id、状态、版本号等）；
 * `disclosed`：业务字段披露集（已办 = 办理上限 ∩ 节点表单 ∩ 当前字段权，现读 = 当前字段权）。
 * 容器键 `submittedFields` / `customFields` 不在字段目录里，不按 viewable 整个放行或整个丢弃：永远出现，内部按披露集逐键裁。
 */
export function projectRequestView(
  request: ContractRequest,
  viewable: ReadonlySet<string> | undefined,
  disclosed: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const canSee = (key: string) => viewable === undefined || viewable.has(key);
  return Object.fromEntries(
    Object.entries(request).flatMap(([key, value]): [string, unknown][] => {
      if (!BUSINESS_KEYS.has(key)) return canSee(key) ? [[key, value]] : [];
      if (key === 'customFields') return [[key, customOf(value, disclosed)]];
      if (key === 'submittedFields') return value ? [[key, submittedView(value, disclosed)]] : [];
      return disclosed === undefined || disclosed.has(key) ? [[key, value]] : [];
    }),
  );
}

function customOf(value: unknown, disclosed: ReadonlySet<string> | undefined) {
  const entries = Object.entries((value ?? {}) as Record<string, unknown>);
  return Object.fromEntries(
    disclosed === undefined ? entries : entries.filter(([id]) => disclosed.has(`custom:${id}`)),
  );
}

/** 提交载荷容器：业务字段按披露集逐键裁，自定义字段按 custom:<id> 裁。 */
export function submittedView(value: unknown, disclosed: ReadonlySet<string> | undefined) {
  const { customFields, ...rest } = value as Record<string, unknown>;
  return {
    ...pickDisclosed(rest, disclosed),
    ...(customFields ? { customFields: customOf(customFields, disclosed) } : {}),
  };
}
