/**
 * 进程入口的数据库选择（F-025 本地演示）：
 * - 设了 DATABASE_URL：连真 PostgreSQL，行为与之前一致（迁移由 `pnpm db:migrate` 单独执行）；
 * - 未设且 NODE_ENV 恰为 development：用落盘的 PGlite（缺省仓库根 `.demo/pglite`，已被 .gitignore 忽略），启动时自动迁移；
 * - 其他情况（production、test、未设置）：不连库，与之前相同，绝不回退到 PGlite。
 *
 * 本地 PGlite 目录只允许在演示根 `.demo/` 之下（#92 第二轮 P2-1）：启动、种子、重置都经 localPgliteDir 解析，
 * 相对路径一律按仓库根解析（与进程当前目录无关），重置只删除带 PGlite 数据库标记的目录。
 */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgDb, type DbHandle, openPgliteDir } from '@italent/db';

/** 本地演示数据的根目录（源码与 dist 运行时都解析到仓库根的 `.demo/`）。 */
export const LOCAL_DEMO_DIR = fileURLToPath(new URL('../../../.demo/', import.meta.url));

/** PGlite（PostgreSQL）数据目录的标记文件：没有它的目录一律不当数据库删除。 */
const PGLITE_MARKER = 'PG_VERSION';

type Env = Readonly<Record<string, string | undefined>>;

export interface LocalDatabaseOptions {
  /** 演示根目录；缺省仓库根 `.demo/`。只有测试会换成临时目录（不经环境变量，避免放宽删除范围）。 */
  readonly demoRoot?: string;
}

function isDevelopment(env: Env): boolean {
  return env.NODE_ENV === 'development';
}

function isStrictlyInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

/** 解析本地 PGlite 目录：相对路径按仓库根（演示根的上级）解析，结果必须严格位于演示根之下，否则报错。 */
export function localPgliteDir(env: Env = process.env, options: LocalDatabaseOptions = {}): string {
  const root = resolve(options.demoRoot ?? LOCAL_DEMO_DIR);
  const configured = env.LOCAL_PGLITE_DIR;
  const dir = configured ? resolve(dirname(root), configured) : join(root, 'pglite');
  if (!isStrictlyInside(root, dir)) {
    throw new Error(`LOCAL_PGLITE_DIR 必须位于演示目录 ${root} 之下（当前解析为 ${dir}）`);
  }
  return dir;
}

/**
 * 演示根的允许范围（#92 第 2 轮审查 P2）：演示根本身不得是符号链接，否则 realpath 会把仓库外目录当成允许范围；
 * 允许范围固定为“仓库根的真实路径 + 演示根目录名”，不跟随演示根上的链接。
 */
function realDemoRoot(options: LocalDatabaseOptions): string {
  const root = resolve(options.demoRoot ?? LOCAL_DEMO_DIR);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`演示目录 ${root} 是符号链接，拒绝使用：须是仓库内的真实目录`);
  }
  return join(realpathSync(dirname(root)), basename(root));
}

/** 应用连接的 application_name（F-082 部署检查脚本按这个前缀数连接，契约 §6.5）：`italent-api:<版本>`。 */
export function applicationNameFromEnv(env: Env = process.env): string {
  return `italent-api:${env.APP_VERSION?.trim() || 'dev'}`;
}

export async function databaseFromEnv(
  env: Env = process.env,
  options: LocalDatabaseOptions = {},
): Promise<DbHandle | undefined> {
  if (env.DATABASE_URL) return createPgDb(env.DATABASE_URL, { applicationName: applicationNameFromEnv(env) });
  if (!isDevelopment(env)) return undefined;
  const dir = localPgliteDir(env, options);
  realDemoRoot(options);
  const handle = await openPgliteDir(dir);
  try {
    await handle.migrate();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * 一键重置：删除本地 PGlite 目录（须先停掉占用它的进程）。只允许在开发环境、未设 DATABASE_URL 时调用；
 * 演示根与目标都不得是符号链接，目标的真实路径须在演示根的真实范围内且带 PGlite 标记，否则拒绝。目录不存在时什么也不做。
 */
export function resetLocalDatabase(env: Env = process.env, options: LocalDatabaseOptions = {}): string {
  if (!isDevelopment(env)) throw new Error('只允许在 NODE_ENV=development 下重置本地演示数据库');
  if (env.DATABASE_URL) throw new Error('设置了 DATABASE_URL：重置只清本地 PGlite，不动真 PostgreSQL，请自行重建该库');
  const dir = localPgliteDir(env, options);
  const root = realDemoRoot(options);
  if (!existsSync(dir)) return dir;
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || !isStrictlyInside(root, realpathSync(dir))) {
    throw new Error(`LOCAL_PGLITE_DIR 指向的 ${dir} 不是演示目录下的真实目录，拒绝删除`);
  }
  if (!existsSync(join(dir, PGLITE_MARKER))) {
    throw new Error(`${dir} 里没有 PGlite 数据库标记（${PGLITE_MARKER}），不像本地演示数据库，拒绝删除`);
  }
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
