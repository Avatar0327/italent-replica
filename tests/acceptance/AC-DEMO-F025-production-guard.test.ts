/**
 * F-025 负向：非开发环境下，进程入口既不回退到本地 PGlite，也不启用开发身份；演示种子拒绝运行。
 * 以真实子进程启动 apps/api 的入口文件，验证的是生产会走到的那条代码路径。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const apiDir = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'italent-f025-guard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runEntry(entry: string, env: Record<string, string>) {
  const dir = join(scratch, `${Math.random().toString(36).slice(2)}.pglite`);
  const { DATABASE_URL: _url, DEV_IDENTITY_SECRET: _secret, ...base } = process.env;
  const result = spawnSync(process.execPath, ['--conditions=@italent/source', '--import', 'tsx', entry], {
    cwd: apiDir,
    env: { ...base, PORT: '0', LOCAL_PGLITE_DIR: dir, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { ...result, dir };
}

describe('F-025 生产路径负向', () => {
  it('NODE_ENV=production 启动后端：即使带了开发签名密钥也拒绝启动，且不创建本地 PGlite', () => {
    const result = runEntry('src/server.ts', { NODE_ENV: 'production', DEV_IDENTITY_SECRET: 'p'.repeat(32) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('B-01');
    expect(existsSync(result.dir)).toBe(false);
  }, 60_000);

  it.each(['production', 'test'])(
    'NODE_ENV=%s 运行演示种子：拒绝执行，不创建本地 PGlite',
    (nodeEnv) => {
      const result = runEntry('src/demo/cli.ts', { NODE_ENV: nodeEnv });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('NODE_ENV=development');
      expect(existsSync(result.dir)).toBe(false);
    },
    60_000,
  );
});
