/** 模块自有错误码保持底座形状，不为新增车道改共享错误枚举。 */
const EMPLOYMENT_STATUS = {
  EMPLOYMENT_FUTURE_VERSION_EXISTS: 409,
  EMPLOYMENT_SAME_DATE_UNRESOLVED: 409,
  EMPLOYMENT_CYCLE_START_UNRESOLVED: 503,
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
