/**
 * BE-7 装配集成（docs/08_设计/R2-T05_兼职设计.md §4.9，§9 PB-79）：生产路径是 server.ts → createApp → TENANT_MODULES →
 * registerEmploymentRoutes，`apps/api/src/index.ts` 只是包导出入口，生产启动不经过它。本用例只经 createApp 建应用
 * （任职会话夹具的 tenantApi），**不导入 index.ts**，也不在测试里手工调任何兼职登记函数：离职落地后兼职被结束
 * （钩子已装），删除含兼职周期的入职记录被拒（探针已装）。另有守卫：install.ts 只被 employment/routes.ts 引用。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferPartTimePortIsDefault } from '../../apps/api/src/modules/transfer/linkage/part-time.js';
import { serviceWorld } from './AC-PT-service-support.js';
import { directImporters, importChainTo } from './support/import-graph.js';

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

  it('PT-6：只从 createApp 建应用，调动端口不是缺省实现、transfer-linkage:part-time 探针生效（联动结束的兼职仍停在该期 → 拒绝删除调动）', async () => {
    const w = await serviceWorld(database().db, 'pt-wiring-transfer');
    expect(transferPartTimePortIsDefault()).toBe(false);
    const record = await w.seedPartTime({ startDate: '2026-09-05', endDate: null });
    const created = await w.request('POST', `/transfers/employees/${w.employeeId}`, {
      ifMatch: (await w.getEmployee(w.employeeId)).revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { departmentId: w.partTimeOrg.id },
        linkage: { partTimes: [{ recordId: record }] },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const transfer = (await created.json()) as { id: string };
    expect((await w.terms(record)).map((term) => [term.end_date, term.source])).toEqual([
      [null, 'create'],
      ['2026-09-19', 'transfer'],
    ]);
    const head = (await (await w.request('GET', `/businesses/${transfer.id}`)).json()) as { revision: number };
    const refused = await w.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: head.revision });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { details: { reason: 'EMPLOYMENT_LINKED_CHANGES_EXIST', linkages: [{ kind: 'partTimeEnd' }] } },
    });
  });

  it('PT-5 开放六视图（见 AC-PT-06-views）：有 view 即 200；没有 view 是 400，不回退到全部，也不是 404', async () => {
    const w = await serviceWorld(database().db, 'pt-wiring-routes');
    expect((await w.request('GET', '/part-times?view=ongoing')).status).toBe(200);
    expect((await w.request('GET', '/part-times')).status).toBe(400);
  });

  it('守卫：本用例的静态依赖图不含 index.ts / @italent/api（只经 app.ts createApp 建应用）', () => {
    // TS AST 解析（support/import-graph.ts），裸 import / 再导出 / 动态 import / require / 目录入口都算引用
    expect(importChainTo(import.meta.filename, { files: [INDEX], packages: ['@italent/api'] })).toBeNull();
  });

  it('守卫：installPartTime 只在 employment/routes.ts 里被引用（生产必经点，不在 index.ts 或别处）', () => {
    const install = join(MODULES, 'modules/employment/part-time/install.ts');
    const users = directImporters(sources(MODULES), install).map((file) => relative(MODULES, file));
    expect(users).toEqual(['modules/employment/routes.ts']);
    // index.ts 的依赖图也不得绕路引用它（只能经 employment/routes.ts → createApp）
    expect(directImporters([INDEX], install)).toEqual([]);
  });
});
