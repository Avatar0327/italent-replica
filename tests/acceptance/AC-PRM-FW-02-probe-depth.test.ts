/** F-231：深度 7 的真实调用链必须能按配置探测；默认深度保持现有冻结基准口径。 */
import type { RouteManifest } from '@italent/api';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeContract } from './support/route-policy/baseline.js';
import { scanPrimitives } from './support/route-policy/primitives.js';
import * as probe from './support/route-policy/probe.js';
import * as scan from './support/route-policy/scan.js';

let root: string;
let index: scan.SourceIndex;
let registration: scan.StaticRegistration;

beforeEach(() => {
  vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', undefined);
  root = mkdtempSync(path.join(os.tmpdir(), 'f231-'));
  // hop0 在深度 0；守卫调用只出现在 hop7，另留 hop8 验证上界，hop7 回指 hop2 验证环。
  writeFileSync(
    path.join(root, 'routes.ts'),
    `router.post('/send', (c) => hop0(c));
${Array.from({ length: 7 }, (_, i) => `function hop${i}(c) { return hop${i + 1}(c); }`).join('\n')}
function hop7(c) { requireLinkedEmploymentRecord(c); authorizeBusinessWrite(c); hop2(c); hop8(c); }
function hop8(c) { beyondConfiguredLimit(c); }
function unrelated(c) { unreachableGuard(c); }
`,
  );
  index = scan.indexSources(root);
  [registration] = scan.scanRegistrations(index) as [scan.StaticRegistration];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function guards(deep: string): readonly string[] {
  return scanPrimitives({ deep, near: scan.closureText(index, registration, 3) }, 'POST', 'employment').guard ?? [];
}

describe('AC-PRM-FW-02 F-231 可配置扫描深度', () => {
  it('默认与显式深度 6 一致，深度 7 守卫不在旧边界内', () => {
    const text = scan.closureText(index, registration);
    expect(text).toBe(scan.closureText(index, registration, 6));
    expect(guards(text)).toEqual([]);
  });

  it('配置为 7 后识别深层守卫，近闭包、无关函数和第 8 层不被扩入', () => {
    vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', '7');
    const trace: string[] = [];
    const text = scan.closureText(index, registration, undefined, trace);
    expect(guards(text)).toEqual(['employment.linkage']);
    expect(text).not.toContain('beyondConfiguredLimit');
    expect(text).not.toContain('unreachableGuard');
    expect(trace.filter((entry) => entry.endsWith('#hop7'))).toHaveLength(1);
    expect(trace.filter((entry) => entry.endsWith('#hop2'))).toHaveLength(1);
    expect(trace.at(-1)).toMatch(/^7:.*#hop7$/);
    expect(guards(scan.closureText(index, registration, 6))).toEqual([]);
  });

  it('提高配置到 8 可以继续展开，并在循环处终止', () => {
    vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', '8');
    const trace: string[] = [];
    expect(scan.closureText(index, registration, undefined, trace)).toContain('beyondConfiguredLimit');
    expect(trace).toHaveLength(9);
  });

  it.each(['', '-1', '1.5', 'NaN', 'Infinity', '7oops', '65'])('非法配置 %j 明确报错', (value) => {
    vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', value);
    expect(() => scan.closureText(index, registration)).toThrow(/ROUTE_POLICY_SCAN_MAX_DEPTH/);
  });

  it.each([0, 64])('接受边界深度 %i', (depth) => {
    vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', String(depth));
    const trace: string[] = [];
    scan.closureText(index, registration, undefined, trace);
    expect(trace).toHaveLength(depth === 0 ? 1 : 9);
  });

  it('基准生成入口确实传递配置，深层守卫进入 primitives，近闭包语义不变', async () => {
    // 只替换源码位置与 HTTP 探测；注册解析、闭包展开、原语匹配和基准组装均执行真实实现。
    vi.spyOn(scan, 'indexSources').mockReturnValue(index);
    vi.spyOn(scan, 'moduleDirs').mockReturnValue({ module: 'employment', prefix: '', subApp: false, dirs: [root] });
    vi.spyOn(probe, 'probeEdges').mockResolvedValue({
      'POST /send': { anonymous: { status: 401 }, nonMember: { status: 403 }, member: { status: 403 } },
    });
    const manifest: RouteManifest = {
      declared: [
        {
          key: 'POST /send',
          method: 'POST',
          path: '/send',
          module: 'employment',
          policy: { kind: 'member', reason: '合成夹具', fields: { mode: 'none', reason: '合成夹具' } },
        },
      ],
      middleware: [],
    };
    const observe = () =>
      observeContract(
        {} as Parameters<typeof observeContract>[0],
        {} as Parameters<typeof observeContract>[1],
        manifest,
      );
    const before = await observe();
    expect(before.routes['POST /send']!.primitives.guard ?? []).toEqual([]);
    vi.stubEnv('ROUTE_POLICY_SCAN_MAX_DEPTH', '7');
    const after = await observe();
    expect(after.routes['POST /send']!.primitives.guard).toEqual(['employment.linkage']);
  });
});
