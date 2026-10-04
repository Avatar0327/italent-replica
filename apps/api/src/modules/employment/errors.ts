/** 模块自有错误码保持底座形状，不为新增车道改共享错误枚举。 */
const EMPLOYMENT_STATUS = {
  EMPLOYMENT_FUTURE_VERSION_EXISTS: 409,
  // DEC-111：早于当前任职周期入职生效日的业务一律拒绝（与员工现有时间轴冲突）
  EMPLOYMENT_BEFORE_CYCLE_ENTRY: 409,
} as const;

export class EmploymentError extends Error {
  constructor(
    readonly code: keyof typeof EMPLOYMENT_STATUS,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EmploymentError';
  }

  get status() {
    return EMPLOYMENT_STATUS[this.code];
  }
}
