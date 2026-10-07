/**
 * 进程入口的数据库选择（F-025 本地演示）：
 * - 设了 DATABASE_URL：连真 PostgreSQL，行为与之前一致（迁移由 `pnpm db:migrate` 单独执行）；
 * - 未设且 NODE_ENV 恰为 development：用落盘的 PGlite（缺省仓库根 `.demo/pglite`，已被 .gitignore 忽略），启动时自动迁移；
 * - 其他情况（production、test、未设置）：不连库，与之前相同，绝不回退到 PGlite。
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgDb, type DbHandle, openPgliteDir } from '@italent/db';

/** 本地演示数据的根目录（源码与 dist 运行时都解析到仓库根的 `.demo/`）。 */
export const LOCAL_DEMO_DIR = fileURLToPath(new URL('../../../.demo/', import.meta.url));

type Env = Readonly<Record<string, string | undefined>>;

function isDevelopment(env: Env): boolean {
  return env.NODE_ENV === 'development';
}

export function localPgliteDir(env: Env = process.env): string {
  return resolve(env.LOCAL_PGLITE_DIR || `${LOCAL_DEMO_DIR}pglite`);
}

export async function databaseFromEnv(env: Env = process.env): Promise<DbHandle | undefined> {
  if (env.DATABASE_URL) return createPgDb(env.DATABASE_URL);
  if (!isDevelopment(env)) return undefined;
  const handle = await openPgliteDir(localPgliteDir(env));
  try {
    await handle.migrate();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/** 一键重置：删除本地 PGlite 目录（须先停掉占用它的进程）。只允许在开发环境调用。 */
export function resetLocalDatabase(env: Env = process.env): string {
  if (!isDevelopment(env)) throw new Error('只允许在 NODE_ENV=development 下重置本地演示数据库');
  const dir = localPgliteDir(env);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
