#!/usr/bin/env node
// 本地演示（F-025）：pnpm demo = 准备 .env.local → 种子（幂等）→ 同时起后端（:3000）与前端（vite :5173）。
// pnpm demo:seed 只跑种子；pnpm demo:reset 删除本地 PGlite 与演示清单后重新种子（须先停掉 pnpm demo）。
// 只用于开发机：强制 NODE_ENV=development；密钥写在被 .gitignore 忽略的 .env.local，不入库。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = `${root}.env.local`;
const apiDir = `${root}apps/api`;
const nodeArgs = ['--conditions=@italent/source', '--import', 'tsx'];

function prepareEnv() {
  const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  if (!/^DEV_IDENTITY_SECRET=.{32,}$/m.test(current)) {
    // 每台开发机各自随机生成；只写本地文件，不打印
    appendFileSync(
      envFile,
      `${current && !current.endsWith('\n') ? '\n' : ''}DEV_IDENTITY_SECRET=${randomBytes(32).toString('hex')}\n`,
    );
    console.log('[demo] 已在 .env.local 生成 DEV_IDENTITY_SECRET（本地文件，不入库）');
  }
  process.loadEnvFile(envFile);
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
    console.error(`[demo] 本地演示只允许 NODE_ENV=development（当前：${process.env.NODE_ENV}）`);
    process.exit(1);
  }
  process.env.NODE_ENV = 'development';
}

function run(command, args, options = {}) {
  return spawn(command, args, { stdio: 'inherit', env: process.env, ...options });
}

function waitFor(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

async function seed() {
  const code = await waitFor(run(process.execPath, [...nodeArgs, 'src/demo/cli.ts'], { cwd: apiDir }));
  if (code !== 0) process.exit(code);
}

function reset() {
  // 只删演示目录下的本地库与清单；设了 DATABASE_URL（真 PG）时不动数据库，提示手工处理
  if (process.env.DATABASE_URL) {
    console.error('[demo] 设置了 DATABASE_URL：重置不会清空真 PostgreSQL，请自行重建该库后再运行 pnpm demo:seed');
    process.exit(1);
  }
  const dir = process.env.LOCAL_PGLITE_DIR || `${root}.demo/pglite`;
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${root}.demo/personas.json`, { force: true });
  console.log(`[demo] 已删除本地演示数据：${dir}`);
}

function serveAll() {
  // 后端：定时生效间隔缩短到 30 秒，便于演示“到期生效”；前端：vite 开发服务器（/api 代理按所选演示身份签名）
  process.env.EMPLOYMENT_ACTIVATION_INTERVAL_MS ||= '30000';
  const children = [
    run(process.execPath, [...nodeArgs, 'src/server.ts'], { cwd: apiDir }),
    run('pnpm', ['--filter', '@italent/web', 'dev'], { cwd: root }),
  ];
  const stop = () => children.forEach((child) => child.exitCode === null && child.kill('SIGINT'));
  for (const child of children) child.on('exit', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

prepareEnv();
const mode = process.argv[2] ?? 'serve';
if (mode === 'reset') reset();
await seed();
if (mode === 'serve') serveAll();
