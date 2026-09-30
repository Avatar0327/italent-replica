import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL daterange，以规范文本形式读写，如 `[2026-01-01,2026-07-01)`；无上界为 `[2026-01-01,)`。
 * 任职等有效期字段统一用它（技术栈评估 §6「版本链」）。
 */
export const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'daterange';
  },
});
