/**
 * AC-DM-30-F493-13：离职列表与详情里导入的单据不带“导入”标识（S3c，设计 §7.1 / 规格 U6）。
 * 北森列表没有“历史导入”这一发起方式：投影把 mode=import 显示为 direct、batchId 置 null，
 * initiation=direct 能筛出，initiation=import 不再是合法取值（400）；库内 exit_requests.mode 仍是 import。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';

const database = useTestDb();

interface Listed {
  id: string;
  mode: string;
  batchId: string | null;
  code: string | null;
}

async function listed(x: ImportWorld, query: string) {
  const response = await x.session.request('GET', `/exits?${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Listed[] }).items;
}

describe('AC-DM-30-F493-13 列表无导入标识', () => {
  it('导入单：mode = direct、batchId = null、可按 direct 筛出；initiation=import 400；详情同；库内仍是 import', async () => {
    const x = await importWorld(database().db, '13');
    const d = await x.dept('列表部门');
    const [row] = await x.rowsOfBatch(await x.imported([x.row(1, d.code)]));
    const businessId = row!.exit_business_id!;

    const all = (await listed(x, 'view=all')).find((item) => item.id === businessId)!;
    expect(all).toMatchObject({ mode: 'direct', batchId: null });
    expect(all).toHaveProperty('batchId'); // 键保留，值为 null
    expect((await listed(x, 'view=all&initiation=direct')).map((item) => item.id)).toContain(businessId);

    const rejected = await x.session.request('GET', '/exits?view=all&initiation=import');
    expect(rejected.status).toBe(400);

    const detail = await x.session.request('GET', `/exits/${businessId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ mode: 'direct', batchId: null });

    // 库内仍记 import；工号列为 null（导入的人员没有工号，展示留空）
    expect(await x.exitRowOf(businessId)).toMatchObject({ mode: 'import' });
    expect(all.code).toBeNull();
  });

  it('批量离职申请的行仍带非空 batchId，不受影响', async () => {
    const x = await importWorld(database().db, '13-batch');
    const hired = await x.hired('批量甲');
    const employee = await x.session.getEmployee(hired.employee.id);
    const response = await x.session.request('POST', '/exits/batch', {
      ifMatch: 0,
      body: { items: [{ employeeId: hired.employee.id, revision: employee.revision, lastWorkDate: '2026-11-20' }] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { batchId, items } = (await response.json()) as { batchId: string; items: { id: string }[] };
    const row = (await listed(x, 'view=all')).find((item) => item.id === items[0]!.id)!;
    expect(row).toMatchObject({ mode: 'application', batchId });
  });
});
