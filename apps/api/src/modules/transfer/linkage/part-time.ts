/**
 * 调整兼职（`21` §2 ParttimeJobApproval，`31` PT-R1）的端口。真实实现在兼职模块
 * （employment/part-time/transfer-port.ts，R2-T05 §4.7），由 employment/routes.ts 经 installPartTime 在 createApp 装配时登记；
 * 未装配的环境保持缺省实现（报告“兼职记录不存在”，保存时即拒绝；结束抛“兼职模块尚未上线”）。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import type { EmploymentContext } from '../../employment/types.js';

/** 调动表单“兼职调整”区的一行：进行中的兼职（Q-M0-121⑥ 列：兼职部门、职务、开始日期、原结束日期）。 */
export interface OngoingPartTime {
  readonly id: string;
  readonly serviceType: string;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
}

export interface OngoingPartTimes {
  readonly items: readonly OngoingPartTime[];
  /** 操作人按 DEC-177 看不到的进行中兼职，只计件数。 */
  readonly hiddenCount: number;
}

export interface TransferPartTimePort {
  /** 该兼职记录属于此员工、仍在进行中，且对操作人可见（DEC-177）；不区分原因。 */
  exists(tx: Tx, ctx: EmploymentContext, input: { employeeId: string; recordId: string }): Promise<boolean>;
  /**
   * 在调用方事务内结束兼职（调用方已持有员工行锁）；endDate = 调动实际生效日 − 1，itemId = 联动子项 ID，
   * 写进期限的 source_id。业务拒绝抛 AppError（记为联动子项失败，可重试）。
   */
  end(
    tx: Tx,
    ctx: EmploymentContext,
    input: { employeeId: string; recordId: string; endDate: string; itemId: string },
  ): Promise<void>;
  /** 调动预览 / 表单“兼职调整”区：asOf 当日进行中的兼职。未装配兼职模块时不提供。 */
  listOngoing?(tx: Tx, ctx: EmploymentContext, employeeId: string, asOf: string): Promise<OngoingPartTimes>;
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

/** 是否仍是缺省实现（装配断言用，AC-PT-wiring）。 */
export function transferPartTimePortIsDefault(): boolean {
  return port === UNAVAILABLE;
}

/** 测试隔离：恢复缺省实现，避免替身泄漏到同文件的其他用例。 */
export function resetTransferPartTimePortForTest(): void {
  port = UNAVAILABLE;
}
