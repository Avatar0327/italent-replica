import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';

export interface VerifiedTransfer {
  readonly businessId: string;
  readonly employeeId: string;
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly effectiveDate: string;
  readonly sourcePositionId?: string | null;
  readonly targetPositionId?: string | null;
  readonly withEstablishment?: boolean;
}

export interface HeadcountQuery {
  readonly tenantId: string;
  readonly orgId: string;
  readonly asOf: string;
  readonly includeDescendants: boolean;
  readonly positionId?: string;
  readonly excludedOrgIds?: readonly string[];
  readonly occupancyRanges?: readonly { readonly employmentType: string }[];
}

/** Q-M0-15：只接受服务端已验证的业务单与同事务人员读写，不接受客户端人数或员工 UUID。 */
export interface EstablishmentPersonnelPort {
  readTransfer(tx: Tx, query: { tenantId: string; businessId: string }): Promise<VerifiedTransfer>;
  headcount(tx: Tx, query: HeadcountQuery): Promise<number>;
  applyTransfer(
    tx: Tx,
    query: { tenantId: string; businessId: string; commandId: string; asOf: string },
  ): Promise<void>;
}

const unavailable = async (): Promise<never> => {
  // TODO(需取证 Q-M0-15): R1-T05/T09 接入真实员工、任职版本及已授权的业务单。
  throw new AppError('SERVICE_UNAVAILABLE', '真实人员与调动接口尚未接入');
};

export const unavailablePersonnel: EstablishmentPersonnelPort = {
  readTransfer: unavailable,
  headcount: unavailable,
  applyTransfer: unavailable,
};
