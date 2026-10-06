/**
 * 调整兼职（`21` §2 ParttimeJobApproval，`31` PT-R1）的端口。兼职模块（R2-T05）尚未上线，任职记录目前只允许
 * 主职（employment_records_primary_only），故缺省实现报告“兼职记录不存在”，保存时即拒绝；R2-T05 上线时登记真实实现。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import type { EmploymentContext } from '../../employment/types.js';

export interface TransferPartTimePort {
  /** 该兼职记录属于此员工且仍可结束。 */
  exists(tx: Tx, ctx: EmploymentContext, input: { employeeId: string; recordId: string }): Promise<boolean>;
  /** 在调用方事务内结束兼职；业务拒绝抛 AppError（记为联动子项失败，可重试）。 */
  end(tx: Tx, ctx: EmploymentContext, input: { employeeId: string; recordId: string; endDate: string }): Promise<void>;
}

const UNAVAILABLE: TransferPartTimePort = {
  exists: async () => false,
  end: async () => {
    throw new AppError('SERVICE_UNAVAILABLE', '兼职模块尚未上线');
  },
};

let port: TransferPartTimePort = UNAVAILABLE;

export function registerTransferPartTimePort(implementation: TransferPartTimePort): void {
  port = implementation;
}

export function transferPartTimePort(): TransferPartTimePort {
  return port;
}
