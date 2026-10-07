/**
 * 本地演示的开发身份切换（F-025），只在 vite 开发服务器（serve + development）里存在：
 * 浏览器只在 Cookie 里记“选了哪个演示用户”，由本插件在 /api 代理上按 identity.ts 的 HMAC 方案签名身份头。
 * 签名密钥 DEV_IDENTITY_SECRET 只在本地 vite 进程里（来自未入库的 .env.local），不下发到浏览器；
 * 浏览器自带的身份头一律剥掉；只给种子清单里的演示用户签名。生产构建不挂本插件（apply）。
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const DEMO_USER_COOKIE = 'italent_demo_user';
export const DEMO_TENANT_COOKIE = 'italent_demo_tenant';
export const DEMO_PERSONAS_PATH = '/__demo/personas';

// 与 apps/api/src/identity.ts 的 DEV_IDENTITY_HEADER 一致；一致性由 AC-DEMO-F025-dev-identity 用后端解析器验证
const USER_HEADER = 'x-dev-user-id';
const SIGNATURE_HEADER = 'x-dev-identity-signature';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;

export interface DemoPersona {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly entry: string;
}

/** 种子脚本写出的演示清单（`.demo/personas.json`，不入库）。 */
export interface DemoManifest {
  readonly tenantId: string;
  readonly personas: readonly DemoPersona[];
}

export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** 按 Cookie 选中的演示用户生成签名身份头；未选、不在清单、缺密钥时返回 null（后端回 401）。 */
export function demoIdentityHeaders(
  cookieHeader: string,
  manifest: DemoManifest | null,
  secret: string | undefined,
): Record<string, string> | null {
  if (!manifest || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  const userId = readCookie(cookieHeader, DEMO_USER_COOKIE);
  if (!userId || !UUID.test(userId)) return null;
  if (!manifest.personas.some((persona) => persona.userId === userId)) return null;
  const signature = createHmac('sha256', secret).update(userId).digest('hex');
  return { [USER_HEADER]: userId, [SIGNATURE_HEADER]: signature };
}

export function readManifest(path: string): DemoManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DemoManifest;
  } catch {
    return null;
  }
}

interface ProxyRequestLike {
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
}

export interface DemoIdentityOptions {
  readonly secret: string | undefined;
  readonly manifestPath: string;
  readonly apiTarget?: string;
}

export function demoIdentityPlugin(options: DemoIdentityOptions) {
  function signProxyRequest(proxyReq: ProxyRequestLike, req: Pick<IncomingMessage, 'headers'>): void {
    proxyReq.removeHeader(USER_HEADER);
    proxyReq.removeHeader(SIGNATURE_HEADER);
    const headers = demoIdentityHeaders(req.headers.cookie ?? '', readManifest(options.manifestPath), options.secret);
    for (const [name, value] of Object.entries(headers ?? {})) proxyReq.setHeader(name, value);
  }

  function servePersonas(req: IncomingMessage, res: ServerResponse): void {
    const manifest = readManifest(options.manifestPath);
    const current = readCookie(req.headers.cookie ?? '', DEMO_USER_COOKIE);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ...(manifest ?? { tenantId: null, personas: [] }), current }));
  }

  const plugin = {
    name: 'italent-demo-identity',
    apply: (_config: object, env: { command: string; mode: string }) =>
      env.command === 'serve' && env.mode === 'development',
    config: () => ({
      server: {
        proxy: {
          '/api': {
            target: options.apiTarget ?? 'http://localhost:3000',
            configure: (proxy: { on(event: 'proxyReq', listener: typeof signProxyRequest): void }) =>
              proxy.on('proxyReq', signProxyRequest),
          },
        },
      },
    }),
    configureServer(server: { middlewares: { use(path: string, handler: typeof servePersonas): void } }) {
      if (!options.secret || options.secret.length < MIN_SECRET_LENGTH)
        console.warn('[demo] 缺少 DEV_IDENTITY_SECRET（≥32 字符，见 .env.example），/api 请求将不带身份（401）');
      server.middlewares.use(DEMO_PERSONAS_PATH, servePersonas);
    },
    signProxyRequest,
  } satisfies Plugin & { signProxyRequest: typeof signProxyRequest };
  return plugin;
}
