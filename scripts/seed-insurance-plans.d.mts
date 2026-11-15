import type { Db } from '@italent/db';

export interface PlanVersionSeed {
  name: string;
  regionCode: string;
  /** 生效月，必须是某月 1 号（YYYY-MM-01）。 */
  effectiveMonth: string;
  /** 停用月（半开区间，停用月本身不再生效）；缺省 = 长期有效。 */
  stopMonth?: string | null;
  enabled?: boolean;
}
export interface PlanSeed {
  /** 租户内唯一的方案业务编码。 */
  code: string;
  versions: PlanVersionSeed[];
}
export interface SeedReceipt {
  plans: { created: number; existing: number };
  versions: { created: number; existing: number };
}
export function seedInsurancePlans(db: Db, tenantId: string, plans: readonly PlanSeed[]): Promise<SeedReceipt>;
