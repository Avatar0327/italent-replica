/**
 * F-097：授权项编码的动态基线。基线不是钉死在测试里的快照，而是“本 PR 的分叉点”上的编码集合：
 * - CI（pull_request）：检出的是 GitHub 的测试合并提交，`GRANT_BASE_REV=HEAD^1` 即 base 分支当前提交，
 *   比较的正是“本 PR 合进最新 main 后带来的编码增删”（分片 job 的 checkout 取 fetch-depth 2）；
 * - 本地：`git merge-base origin/main HEAD`；
 * - 设了 GRANT_BASE_REV 却解析不到时报错（CI 上不允许静默跳过）；没设且取不到 merge-base（无 git / 无 origin/main）时跳过并说明。
 * 基线提交上的编码由 `git archive` 导出 packages/domain/src 到临时目录后直接加载（该目录不依赖 npm 包）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRANTS_PATH } from '../../../scripts/merge-main-lib.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const git = (...argv: string[]) =>
  spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }) as {
    status: number | null;
    stdout: string;
    stderr: string;
  };

export type GrantBase = { sha: string; how: string } | { skip: string };

export function resolveGrantBase(env: NodeJS.ProcessEnv = process.env): GrantBase {
  const rev = env.GRANT_BASE_REV?.trim();
  if (rev) {
    const run = git('rev-parse', '--verify', '-q', `${rev}^{commit}`);
    if (run.status !== 0)
      throw new Error(`GRANT_BASE_REV=${rev} 解析不到提交（CI 分片的 checkout 需要 fetch-depth: 2）：${run.stderr}`);
    return { sha: run.stdout.trim(), how: `GRANT_BASE_REV=${rev}` };
  }
  const run = git('merge-base', 'origin/main', 'HEAD');
  if (run.status !== 0) return { skip: `取不到 git merge-base origin/main HEAD：${run.stderr.trim() || '无输出'}` };
  return { sha: run.stdout.trim(), how: 'git merge-base origin/main HEAD' };
}

/** 基线提交上某个文件的内容；不存在返回 undefined。 */
export function fileAt(sha: string, file: string): string | undefined {
  const run = git('show', `${sha}:${file}`);
  return run.status === 0 ? run.stdout : undefined;
}

/** 工作区里某个文件的内容（与 STANDARD_GRANT_CODES 同口径：都读工作区）。 */
export const fileNow = (file: string): string | undefined => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
};

/** 基线提交上的 STANDARD_GRANT_CODES。 */
export async function grantCodesAt(sha: string): Promise<readonly string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'grant-base-'));
  try {
    execFileSync('sh', ['-c', 'git archive --format=tar "$1" packages/domain/src | tar -x -C "$2"', 'sh', sha, dir], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const module = (await import(/* @vite-ignore */ path.join(dir, GRANTS_PATH))) as {
      STANDARD_GRANT_CODES: readonly string[];
    };
    return module.STANDARD_GRANT_CODES;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
