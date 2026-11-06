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

/** PostgreSQL bytea，读写 Buffer（PGlite 返回 Uint8Array 时在读取处归一）。附件字节表专用（F-479 S1）。 */
export const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});
