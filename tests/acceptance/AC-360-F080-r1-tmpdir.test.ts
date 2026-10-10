/**
 * F-080 渲染用 fontconfig 临时目录的清理（#198 第 1 轮 P3，第 3 轮 P2-3 改口）：
 * - **不接管 SIGINT / SIGTERM**：以前为让被信号终止的进程也清理目录而在信号上挂监听并重发信号，会抢在既有异步停机流程
 *   （server.ts 里落盘 PGlite 的 `handle.close().finally(process.exit)`）之前终止进程，关库做不完。现在只靠进程正常
 *   退出时的 exit 事件清理，被信号终止留下的目录由**下一次启动回收**；字体模块不在信号上挂任何监听器；
 * - 启动时回收崩溃 / 被信号终止留下的残余目录：目录名带创建进程的 PID，只回收所属进程已不存在的；存活进程的、
 *   不符合命名的目录一律不动（启动检查与首次创建目录时各回收一次）；
 * - 真实落盘 PGlite 回归：渲染过一次（创建了字体环境）后收到 SIGINT / SIGTERM，PGlite 的异步关库照常完成
 *   （CLOSE_COMPLETED），退出码与不创建字体环境时一致。
 * 信号与首次渲染用子进程（node 直接跑 export-fonts.ts）验证，启动检查在本进程内验证；TMPDIR 都指向测试独占的目录，
 * 不碰真实临时目录。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exportStartupCheck } from '../../apps/api/src/modules/survey360/export-files.js';

const ROOT = process.cwd();
const FONTS_TS = join(ROOT, 'apps/api/src/modules/survey360/export-fonts.ts');
const DATABASE_TS = join(ROOT, 'apps/api/src/database.ts');
const PREFIX = 'italent-export-fontconfig-';

type Closed = { code: number | null; signal: NodeJS.Signals | null };
interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly closed: Promise<Closed>;
}

const children: ChildProcess[] = [];
// 断言失败时也要收掉子进程（它们一直活着等信号，会让 vitest 退不出去）
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

const isolatedTmp = () => mkdtempSync(join(tmpdir(), 'f080-tmp-'));
const mine = (tmp: string) => readdirSync(tmp).filter((name) => name.startsWith(PREFIX));
const scriptFile = (source: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'f080-script-')), 'run.mjs');
  writeFileSync(file, source);
  return file;
};
const FONTS_URL = pathToFileURL(FONTS_TS).href;

/** 起子进程，等它打印 READY。纯 JS 脚本用 node 直接跑 export-fonts.ts（不经 tsx：tsx 外壳会自己接管信号）。 */
async function start(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Running> {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd,
  });
  children.push(child);
  const closed = new Promise<Closed>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let out = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('READY')) resolve();
    });
    child.once('close', () => reject(new Error(`子进程提前退出：${out}`)));
  });
  return { child, output: () => out, closed: closed.then((result) => ({ ...result })) };
}

const NODE_TS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const envScript = (tail: string) =>
  scriptFile(
    `import { exportFontEnv } from '${FONTS_URL}';\n` +
      `const env = await exportFontEnv();\nconsole.log('DIR ' + env.FONTCONFIG_PATH);\n` +
      `console.log('LISTENERS ' + process.listenerCount('SIGINT') + ' ' + process.listenerCount('SIGTERM'));\n${tail}`,
  );
const startEnv = (tmp: string, tail = "console.log('READY');\nsetInterval(() => undefined, 1000);\n") =>
  start([...NODE_TS, envScript(tail)], { TMPDIR: tmp });
const dirOf = (running: Running) => /DIR (.*)/.exec(running.output())![1]!.trim();

describe('AC-360-F080 R1 fontconfig 临时目录：不接管信号，退出清理 + 启动回收', () => {
  it('目录名带创建进程的 PID；字体模块不在 SIGINT / SIGTERM 上挂任何监听器', async () => {
    const tmp = isolatedTmp();
    const running = await startEnv(tmp);
    expect(mine(tmp)[0]).toMatch(new RegExp(`^${PREFIX}\\d+-`));
    expect(/LISTENERS (\d+) (\d+)/.exec(running.output())!.slice(1)).toEqual(['0', '0']);
    running.child.kill('SIGKILL');
    await running.closed;
  }, 30_000);

  it('进程正常退出：exit 事件清理目录', async () => {
    const tmp = isolatedTmp();
    const running = await startEnv(tmp, "console.log('READY');\nsetTimeout(() => process.exit(0), 300);\n");
    const result = await running.closed;
    expect(result.code).toBe(0);
    expect(mine(tmp)).toEqual([]);
  }, 30_000);

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '收到 %s：字体模块不抢控制权，进程按默认行为被该信号终止；残留目录由下一次启动回收',
    async (signal) => {
      const tmp = isolatedTmp();
      const running = await startEnv(tmp);
      const dir = dirOf(running);
      running.child.kill(signal);
      const result = await running.closed;
      expect(result.signal, '被原信号终止（没有被字体监听器改写或重发）').toBe(signal);
      expect(existsSync(dir), '被信号终止不触发 exit，目录残留').toBe(true);
      // 下一次启动（首次创建目录）回收
      const next = await startEnv(tmp);
      expect(existsSync(dir), '残留目录已回收').toBe(false);
      expect(mine(tmp)).toHaveLength(1);
      next.child.kill('SIGKILL');
      await next.closed;
    },
    30_000,
  );

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
});

/**
 * 真实落盘 PGlite（不是 mock）：脚本复刻 server.ts 的收尾——`process.once(信号, () => handle.close().finally(exit(0)))`，
 * 在**注册完收尾之后**才创建字体环境（与线上顺序一致：服务启动时注册，首次渲染才创建字体环境）。
 */
describe('AC-360-F080 R3 P2-3 字体环境不抢占落盘 PGlite 的异步关库', () => {
  const demo = join(ROOT, '.demo');
  const name = `f080-pglite-${process.pid}-${Date.now()}`;
  const pgliteDir = join(demo, name);
  const loader = ['--import', 'tsx', '--disable-warning=ExperimentalWarning'];

  const pgliteScript = (withFonts: boolean) =>
    scriptFile(
      `import { databaseFromEnv } from '${pathToFileURL(DATABASE_TS).href}';\n` +
        `import { exportFontEnv } from '${FONTS_URL}';\n` +
        `const handle = await databaseFromEnv();\n` +
        `for (const signal of ['SIGINT', 'SIGTERM']) {\n` +
        `  process.once(signal, () => {\n    console.log('CLOSE_STARTED');\n` +
        `    void handle.close().finally(() => {\n      console.log('CLOSE_COMPLETED');\n      process.exit(0);\n` +
        `    });\n  });\n}\n` +
        `${withFonts ? 'await exportFontEnv();\n' : ''}console.log('READY');\nsetInterval(() => undefined, 1000);\n`,
    );

  const run = async (signal: 'SIGINT' | 'SIGTERM', withFonts: boolean) => {
    const running = await start(
      [...loader, pgliteScript(withFonts)],
      { NODE_ENV: 'development', LOCAL_PGLITE_DIR: `.demo/${name}`, DATABASE_URL: '', TMPDIR: isolatedTmp() },
      join(ROOT, 'apps/api'),
    );
    running.child.kill(signal);
    const result = await running.closed;
    return { result, output: running.output() };
  };

  afterEach(() => rmSync(pgliteDir, { recursive: true, force: true }));

  it('server.ts 的收尾写法与脚本一致（防止脚本与真实入口脱节）', () => {
    const server = readFileSync(join(ROOT, 'apps/api/src/server.ts'), 'utf8');
    expect(server).toContain("for (const signal of ['SIGINT', 'SIGTERM'] as const)");
    expect(server).toContain('process.once(signal, () => void handle.close().finally(() => process.exit(0)));');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    '渲染过一次（已创建字体环境）后收到 %s：CLOSE_COMPLETED 且退出码与不创建字体环境时一致',
    async (signal) => {
      const baseline = await run(signal, false);
      expect(baseline.output).toContain('CLOSE_COMPLETED');
      expect(baseline.result).toEqual({ code: 0, signal: null });
      const withFonts = await run(signal, true);
      expect(withFonts.output, '关库做完了才退出').toContain('CLOSE_COMPLETED');
      expect(withFonts.result).toEqual(baseline.result);
    },
    180_000,
  );
});
