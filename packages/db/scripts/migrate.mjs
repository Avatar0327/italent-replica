// 对 DATABASE_URL 指向的库执行全部迁移：pnpm db:migrate
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少环境变量 DATABASE_URL（见 .env.example）');
  process.exit(1);
}
const client = postgres(url, { max: 1, onnotice: () => undefined });
try {
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  console.log('迁移完成');
} finally {
  await client.end();
}
