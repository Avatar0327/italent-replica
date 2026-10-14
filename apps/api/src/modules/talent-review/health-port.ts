/**
 * 组织健康度计算端口（《R3-T04/T05 同步协议》SP-15）：T04 定签名，T05 实现并在装配时登记。T04 项目页“计算健康度”
 * 与 T05 自有计算都经它；未登记时 T04 入口返回 400 HEALTH_COMPUTE_UNAVAILABLE（requireOrgHealthComputePort）。
 * 一个进程只有一个实现：重复登记同一实现幂等，登记不同实现视为装配错误（避免两个模块各算一套）。
 */
import type { Tx } from '@italent/db';
import type { HealthLevel, IsoDate, OrgHealthContext } from '@italent/domain';
import { AppError } from '../../errors.js';

export interface OrgHealthComputeResult {
  readonly orgId: string;
  readonly levelId: string | null;
  readonly levelCode: string | null;
  readonly failures: readonly { readonly code: string; readonly params?: Readonly<Record<string, unknown>> }[];
}

export interface OrgHealthComputePort {
  compute(
    tx: Tx,
    input: {
      tenantId: string;
      principalUserId: string;
      context: OrgHealthContext;
      orgIds: readonly string[];
      businessDate: IsoDate;
    },
  ): Promise<readonly OrgHealthComputeResult[]>;
  listLevels(tx: Tx, input: { tenantId: string }): Promise<readonly HealthLevel[]>;
}

let registered: OrgHealthComputePort | null = null;

export function registerOrgHealthComputePort(port: OrgHealthComputePort): void {
  if (registered && registered !== port) throw new Error('组织健康度计算端口已登记了另一个实现');
  registered = port;
}

/** 当前登记的实现；未登记为 null。 */
export const orgHealthComputePort = (): OrgHealthComputePort | null => registered;

/** T04 入口用：未登记 → 400 HEALTH_COMPUTE_UNAVAILABLE（SP-15）。 */
export function requireOrgHealthComputePort(): OrgHealthComputePort {
  if (!registered) {
    throw new AppError('VALIDATION_FAILED', '健康度计算暂不可用', { reason: 'HEALTH_COMPUTE_UNAVAILABLE' });
  }
  return registered;
}

/** 仅供测试复位登记状态。 */
export function resetOrgHealthComputePortForTest(): void {
  registered = null;
}
