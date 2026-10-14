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
// 与应用进程同一前缀（italent-api:<APP_VERSION>）：F-082 的部署检查脚本按它数目标库上的应用连接
const applicationName = `italent-api:${process.env.APP_VERSION?.trim() || 'dev'}`;
const client = postgres(url, { max: 1, onnotice: () => undefined, connection: { application_name: applicationName } });
try {
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  console.log('迁移完成');
} finally {
  await client.end();
}
