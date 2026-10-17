/**
 * BE-7 装配集成（docs/08_设计/R2-T05_兼职设计.md §4.9，§9 PB-79）：生产路径是 server.ts → createApp → TENANT_MODULES →
 * registerEmploymentRoutes，`apps/api/src/index.ts` 只是包导出入口，生产启动不经过它。本用例只经 createApp 建应用
 * （任职会话夹具的 tenantApi），**不导入 index.ts**，也不在测试里手工调任何兼职登记函数：离职落地后兼职被结束
 * （钩子已装），删除含兼职周期的入职记录被拒（探针已装）。另有守卫：install.ts 只被 employment/routes.ts 引用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { serviceWorld } from './AC-PT-service-support.js';

const database = useTestDb();
const MODULES = resolve(import.meta.dirname, '../../apps/api/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const INDEX = resolve(MODULES, 'index.ts');

/** 从本测试出发沿相对 import 走静态依赖图，返回会加载 index.ts / @italent/api 的第一条链（没有则 null）。 */
function indexImportChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1]!;
      if (spec === '@italent/api' || spec.startsWith('@italent/api/')) return [...chain, file, spec];
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (target === INDEX) return [...chain, file, 'index.ts'];
      if (existsSync(target)) {
        const found = visit(target, [...chain, file]);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(entry, []);
}

describe('AC-PT-wiring 兼职装配（PB-79）', () => {
  it('只从 createApp 建应用：离职落地结束兼职；删除含兼职周期的入职记录被拒', async () => {
    const w = await serviceWorld(database().db, 'pt-wiring');
    const record = await w.seedPartTime({ startDate: '2026-09-01', endDate: null });
    const hire = (await w.records(w.employeeId)).find((item) => item.kind === 'hire')!;
    const head = (await (await w.request('GET', `/businesses/${hire.id}`)).json()) as { revision: number };
    const refused = await w.request('DELETE', `/businesses/${hire.id}`, { ifMatch: head.revision });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { details: { reason: 'EMPLOYMENT_LINKED_CHANGES_EXIST' } },
    });
    const exit = await w.leave('2026-09-15');
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: null, source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-15', source: 'exit', source_id: exit.id },
    ]);
  });

  it('兼职路由在 PT-3a 未注册：404（内部服务 / 钩子 / 探针 / 停用计数，不开放新入口）', async () => {
    const w = await serviceWorld(database().db, 'pt-wiring-routes');
    for (const [method, path] of [
      ['GET', `/employees/${w.employeeId}/part-times`],
      ['POST', `/employees/${w.employeeId}/part-times`],
      ['POST', `/employees/${w.employeeId}/part-times/preview`],
      ['PATCH', `/part-times/${w.employeeId}`],
      ['POST', '/part-times/batch-end'],
      ['GET', '/part-times'],
      ['POST', '/part-time-requests'],
    ] as const) {
      const response = await w.request(method, path, method === 'GET' ? {} : { ifMatch: 1, body: {} });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('守卫：本用例的静态依赖图不含 index.ts / @italent/api（只经 app.ts createApp 建应用）', () => {
    expect(indexImportChain(import.meta.filename)).toBeNull();
  });

  it('守卫：installPartTime 只在 employment/routes.ts 里被引用（生产必经点，不在 index.ts 或别处）', () => {
    const users = sources(MODULES)
      .filter((file) => /part-time\/install(\.js)?['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(MODULES, file));
    expect(users).toEqual(['modules/employment/routes.ts']);
    expect(readFileSync(join(MODULES, 'index.ts'), 'utf8')).not.toContain('part-time/install');
  });
});
