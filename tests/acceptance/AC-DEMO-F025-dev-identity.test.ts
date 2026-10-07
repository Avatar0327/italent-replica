/**
 * F-025 本地演示：开发身份切换只在 vite 开发服务器里存在，复用 identity.ts 的 HMAC 签名身份头；
 * 生产构建不含切换组件、不挂签名代理（负向）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevIdentityResolver, DEV_IDENTITY_HEADER } from '@italent/api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEMO_TENANT_COOKIE,
  DEMO_USER_COOKIE,
  demoIdentityHeaders,
  demoIdentityPlugin,
  type DemoManifest,
} from '../../apps/web/dev/demo-identity.js';

const secret = 'f025'.repeat(8);
const manifest: DemoManifest = {
  tenantId: '00000000-0000-4000-8000-00000000d001',
  personas: [
    { userId: '00000000-0000-4000-8000-00000000d101', name: '演示员工', role: 'employee', entry: '/self' },
    { userId: '00000000-0000-4000-8000-00000000d102', name: '演示经理', role: 'manager', entry: '/manager' },
  ],
};
const employee = manifest.personas[0]!;

const scratch = mkdtempSync(join(tmpdir(), 'italent-f025-vite-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * 起一个记录请求头的上游，再起真实 vite 开发服务器或 preview（与 vite.config.ts 一样配 /api 代理并挂插件），
 * 带演示用户 Cookie 与伪造身份头请求 /api/probe，返回上游看到的请求头（没收到请求时为 null）。
 */
async function probeThroughVite(input: { nodeEnv: string; mode: string; server: 'dev' | 'preview' }) {
  const vite = await import('vite');
  let seen: IncomingHttpHeaders | null = null;
  const upstream = createHttpServer((req, res) => {
    seen = req.headers;
    res.end('{}');
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const root = mkdtempSync(join(scratch, 'root-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>probe</title>');
  const manifestPath = join(root, 'personas.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const config = {
    root,
    configFile: false as const,
    logLevel: 'silent' as const,
    mode: input.mode,
    plugins: [demoIdentityPlugin({ secret, manifestPath, apiTarget: target })],
    server: { port: 0, host: '127.0.0.1', proxy: { '/api': { target } } },
    preview: { port: 0, host: '127.0.0.1', proxy: { '/api': { target } } },
    build: { outDir: root },
  };
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = input.nodeEnv;
  try {
    const running = input.server === 'dev' ? await vite.createServer(config) : await vite.preview(config);
    try {
      if ('listen' in running) await running.listen();
      const address = running.httpServer!.address() as { port: number };
      await fetch(`http://127.0.0.1:${address.port}/api/probe`, {
        headers: {
          cookie: `${DEMO_USER_COOKIE}=${employee.userId}`,
          [DEV_IDENTITY_HEADER.user]: employee.userId,
          [DEV_IDENTITY_HEADER.signature]: 'ab'.repeat(32),
        },
      });
    } finally {
      await running.close();
    }
  } finally {
    process.env.NODE_ENV = nodeEnv;
    await new Promise((done) => upstream.close(done));
  }
  return seen as Record<string, string> | null;
}

function resolve(headers: Record<string, string>) {
  const resolver = createDevIdentityResolver({ secret, nodeEnv: 'development' });
  return resolver.resolve(new Request('http://localhost/api/tenant/x', { headers }));
}

describe('F-025 开发身份切换（vite 开发代理签名）', () => {
  it('按 Cookie 里选定的演示用户签名，后端现有 HMAC 开发身份能解析', async () => {
    const headers = demoIdentityHeaders(`a=1; ${DEMO_USER_COOKIE}=${employee.userId}`, manifest, secret);
    expect(headers).not.toBeNull();
    expect(await resolve(headers!)).toBe(employee.userId);
  });

  it('只给清单内的演示用户签名；未选、乱填或缺密钥时不签名（后端回 401）', () => {
    const outsider = '00000000-0000-4000-8000-00000000d999';
    expect(demoIdentityHeaders('', manifest, secret)).toBeNull();
    expect(demoIdentityHeaders(`${DEMO_USER_COOKIE}=${outsider}`, manifest, secret)).toBeNull();
    expect(demoIdentityHeaders(`${DEMO_USER_COOKIE}=not-a-uuid`, manifest, secret)).toBeNull();
    expect(demoIdentityHeaders(`${DEMO_USER_COOKIE}=${employee.userId}`, manifest, undefined)).toBeNull();
    expect(demoIdentityHeaders(`${DEMO_USER_COOKIE}=${employee.userId}`, null, secret)).toBeNull();
  });

  it('浏览器自带的身份头一律剥掉，不能绕过代理自签', async () => {
    const plugin = demoIdentityPlugin({ secret, manifestPath: '/nonexistent/personas.json' });
    const forged: Record<string, string> = {
      [DEV_IDENTITY_HEADER.user]: employee.userId,
      [DEV_IDENTITY_HEADER.signature]: 'ab'.repeat(32),
    };
    expect(await resolve(forged)).toBeNull();
    // 代理把浏览器请求头原样拷到上游请求后触发 proxyReq：插件必须先剥掉，再按清单决定是否签名
    const upstream: Record<string, string> = { ...forged, accept: 'application/json' };
    plugin.signProxyRequest(
      {
        removeHeader: (name) => delete upstream[name],
        setHeader: (name, value) => void (upstream[name] = value),
      },
      { headers: { cookie: `${DEMO_USER_COOKIE}=${employee.userId}` } },
    );
    // 清单不存在 → 不签名，也不保留伪造头
    expect(upstream).toEqual({ accept: 'application/json' });
  });

  // P2-2（#92 第二轮）：只有 NODE_ENV=development + mode=development + 开发服务器才签名；preview 一律不签
  it.each([
    { nodeEnv: 'development', mode: 'development', server: 'dev' },
    { nodeEnv: 'development', mode: 'development', server: 'preview' },
    { nodeEnv: 'development', mode: 'production', server: 'dev' },
    { nodeEnv: 'development', mode: 'production', server: 'preview' },
    { nodeEnv: 'production', mode: 'development', server: 'dev' },
    { nodeEnv: 'production', mode: 'development', server: 'preview' },
    { nodeEnv: 'production', mode: 'production', server: 'dev' },
    { nodeEnv: 'production', mode: 'production', server: 'preview' },
  ] as const)(
    '真实 vite 服务器 NODE_ENV=$nodeEnv mode=$mode $server：只有开发服务器 + development 才签名，伪造头一律剥掉',
    async ({ nodeEnv, mode, server }) => {
      const seen = await probeThroughVite({ nodeEnv, mode, server });
      // 代理本身通着（请求到了上游），区别只在是否附加签名身份头
      expect(seen).not.toBeNull();
      const signed = nodeEnv === 'development' && mode === 'development' && server === 'dev';
      if (signed) expect(await resolve(seen!)).toBe(employee.userId);
      else {
        expect(seen![DEV_IDENTITY_HEADER.signature]).toBeUndefined();
        expect(await resolve(seen!)).toBeNull();
      }
    },
    60_000,
  );

  it('生产构建不包含“切换演示身份”组件、演示 Cookie 名与演示清单接口', async () => {
    const { build } = await import('vite');
    const root = fileURLToPath(new URL('../../apps/web/', import.meta.url));
    // 与 `vite build` 命令一致：vitest 把 NODE_ENV 设成 test，构建期间临时还原为 production
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const output = await build({
      root,
      configFile: `${root}vite.config.ts`,
      mode: 'production',
      logLevel: 'silent',
      build: { write: false },
    }).finally(() => {
      process.env.NODE_ENV = nodeEnv;
    });
    const bundles = (Array.isArray(output) ? output : [output]) as { output: { code?: string; source?: unknown }[] }[];
    const text = bundles
      .flatMap((bundle) => bundle.output)
      .map((chunk) => chunk.code ?? String(chunk.source ?? ''))
      .join('\n');
    expect(text.length).toBeGreaterThan(1000);
    for (const marker of ['切换演示身份', DEMO_USER_COOKIE, DEMO_TENANT_COOKIE, '/__demo/']) {
      expect(text, marker).not.toContain(marker);
    }
  }, 120_000);
});
