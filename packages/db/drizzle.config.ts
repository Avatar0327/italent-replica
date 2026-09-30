import { defineConfig } from 'drizzle-kit';

// 只用于 `pnpm db:generate` 生成迁移；生成不需要连接数据库。
// 排除约束、RLS、分区等 Drizzle 表达不了的，用 `drizzle-kit generate --custom` 手写 SQL 迁移（技术栈评估 §6）。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
