import { serve } from '@hono/node-server';
import { createPgDb } from '@italent/db';
import { createApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
const handle = databaseUrl ? createPgDb(databaseUrl) : undefined;
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp(handle ? { db: handle.db } : {}).fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
