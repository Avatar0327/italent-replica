/**
 * F-080 第 1 轮 P3（PR #198 审查）：渲染用 fontconfig 临时目录的清理。
 * - 正常停机（SIGTERM / SIGINT）也要清理（以前只在 exit 事件里清，被信号终止的进程不触发 exit）；清理后仍按原信号终止；
 * - 启动时回收崩溃（SIGKILL / 断电）留下的残余目录：目录名带创建进程的 PID，只回收所属进程已不存在的；存活进程的、
 *   不符合命名的目录一律不动。
 * 信号与首次渲染用子进程（node 直接跑 export-fonts.ts）验证，启动检查在本进程内验证；TMPDIR 都指向测试独占的目录，
 * 不碰真实临时目录。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportStartupCheck } from '../../apps/api/src/modules/survey360/export-files.js';

const ROOT = process.cwd();
const FONTS_TS = join(ROOT, 'apps/api/src/modules/survey360/export-fonts.ts');
const PREFIX = 'italent-export-fontconfig-';

/**
 * 子进程脚本（纯 JS，用 node 直接跑 export-fonts.ts，不经 tsx：tsx 外壳会自己接管信号，掩盖“被信号终止不触发 exit”）：
 * 创建渲染环境，打印 FONTCONFIG_PATH 所在目录与 READY，然后一直活着等信号。
 */
function script(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'f080-script-')), 'env.mjs');
  writeFileSync(
    file,
    `import { exportFontEnv } from '${pathToFileURL(FONTS_TS).href}';\n` +
      `const env = await exportFontEnv();\nconsole.log('DIR ' + env.FONTCONFIG_PATH);\nconsole.log('READY');\n` +
      `setInterval(() => undefined, 1000);\n`,
  );
  return file;
}

interface Running {
  readonly child: ChildProcess;
  readonly dir: string;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function start(tmp: string): Promise<Running> {
  const args = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script()];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  let out = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('READY')) resolve();
    });
    child.once('close', () => reject(new Error(`子进程提前退出：${out}`)));
  });
  return { child, dir: /DIR (.*)/.exec(out)![1]!.trim(), closed };
}

const isolatedTmp = () => mkdtempSync(join(tmpdir(), 'f080-tmp-'));
const mine = (tmp: string) => readdirSync(tmp).filter((name) => name.startsWith(PREFIX));

describe('AC-360-F080 R1 P3 fontconfig 临时目录清理', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    '收到 %s：先清理临时目录，再按原信号终止',
    async (signal) => {
      const tmp = isolatedTmp();
      const running = await start(tmp);
      expect(mine(tmp)).toHaveLength(1);
      expect(existsSync(running.dir)).toBe(true);
      running.child.kill(signal);
      const result = await running.closed;
      expect(mine(tmp), '被信号终止后目录已清理').toEqual([]);
      // 仍然是被该信号终止（tsx 外壳会把子进程的信号转成 128+n 的退出码）
      expect(result.signal === signal || result.code === 128 + (signal === 'SIGTERM' ? 15 : 2)).toBe(true);
    },
    30_000,
  );

  it('目录名带创建进程的 PID', async () => {
    const tmp = isolatedTmp();
    const running = await start(tmp);
    expect(mine(tmp)[0]).toMatch(new RegExp(`^${PREFIX}\\d+-`));
    running.child.kill('SIGTERM');
    await running.closed;
  }, 30_000);

  it('启动检查回收崩溃残留：所属进程已不存在的目录被删，存活进程的与不符合命名的目录不动', async () => {
    const tmp = isolatedTmp();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const staleDead = join(tmp, `${PREFIX}${dead}-abc123`);
    const alive = join(tmp, `${PREFIX}${process.pid}-live01`);
    const legacy = join(tmp, `${PREFIX}abc123`);
    const foreign = join(tmp, 'other-dir');
    for (const dir of [staleDead, alive, legacy, foreign]) {
      mkdirSync(join(dir, 'cache'), { recursive: true });
      writeFileSync(join(dir, 'fonts.conf'), '<fontconfig/>');
    }
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      await exportStartupCheck(() => undefined);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(existsSync(staleDead), '崩溃残留已回收').toBe(false);
    for (const dir of [alive, legacy, foreign]) expect(existsSync(dir), dir).toBe(true);
  });

  it('首次渲染创建目录时同样回收残留', async () => {
    const tmp = isolatedTmp();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const staleDead = join(tmp, `${PREFIX}${dead}-abc123`);
    mkdirSync(staleDead, { recursive: true });
    const running = await start(tmp);
    expect(existsSync(staleDead)).toBe(false);
    expect(mine(tmp)).toHaveLength(1);
    running.child.kill('SIGTERM');
    await running.closed;
  }, 30_000);
});
