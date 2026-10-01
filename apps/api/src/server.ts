import { serve } from '@hono/node-server';
import { createPgDb } from '@italent/db';
import { createApp } from './app.js';
import { identityResolverFromEnv } from './identity.js';

// 生产环境未接入真实登录（B-01）时，这里直接抛错阻止启动，不回退到不安全的身份实现。
// 授权不在此注入：createApp 缺省使用 defaultAuthorizer（一律拒绝），R1-T01 接入前所有租户接口返回 403。
const identity = identityResolverFromEnv();
const databaseUrl = process.env.DATABASE_URL;
const handle = databaseUrl ? createPgDb(databaseUrl) : undefined;
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp(handle ? { db: handle.db, identity } : { identity }).fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
