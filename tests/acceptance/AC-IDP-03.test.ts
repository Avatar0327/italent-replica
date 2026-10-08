/**
 * AC-IDP-03（docs/02_业务建模/28 §5、IDP-R5）：被模板引用的发展计划流程不能改子流程顺序和开启方式。
 * 口径（PR 描述口径清单 K-24 🟡）：增删子流程同样改变顺序，一并拒绝；开启规则的细节（时间类型、参照点、天数）可以改；
 * 没被引用的流程可以自由调整。拒绝时 409 + 机器可读原因，前后各读一次比对数据未变。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorCode } from './support/tenant-api.js';
import { idpWorld, type ProcessView, subProcessBody } from './AC-IDP-support.js';

const testDb = useTestDb();

const reorderBody = (process: ProcessView) => {
  const [first, second, third] = process.subProcesses;
  return [second, first, third].map((sub) => ({ ...sub, ruleText: undefined }));
};
const asInput = (process: ProcessView) => process.subProcesses.map(({ ruleText: _ruleText, ...rest }) => rest);

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

describe('AC-IDP-03 被模板引用的流程不能改子流程顺序和开启方式', () => {
  it('引用后调整顺序 → 409 IDP_PROCESS_REFERENCED，流程不变', async () => {
    const w = await idpWorld(testDb().db, 'idp03a');
    const process = await w.process();
    await w.template(process.id);
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    expect(before.referenced).toBe(true);

    const response = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: before.revision,
      body: { subProcesses: reorderBody(before) },
    });
    expect(response.status).toBe(409);
    expect(await reasonOf(response)).toEqual({ code: 'CONFLICT', reason: 'IDP_PROCESS_REFERENCED' });
    expect(await w.read<ProcessView>(`/processes/${process.id}`)).toEqual(before);
  });

  it('引用后改开启方式、增加或删除子流程 → 409，流程不变', async () => {
    const w = await idpWorld(testDb().db, 'idp03b');
    const process = await w.process();
    await w.template(process.id);
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    const input = asInput(before);
    const attempts = [
      // 中期回顾 手动 → 自动
      input.map((sub, index) => (index === 1 ? { ...sub, startMode: 'auto' } : sub)),
      // 增加一段
      [...input, subProcessBody(w.approvals.final.id, { name: '追加回顾', category: 'review' })],
      // 删除最后一段
      input.slice(0, 2),
    ];
    for (const subProcesses of attempts) {
      const response = await w.request('PATCH', `/processes/${process.id}`, {
        ifMatch: before.revision,
        body: { subProcesses },
      });
      expect(response.status).toBe(409);
      expect(await reasonOf(response)).toEqual({ code: 'CONFLICT', reason: 'IDP_PROCESS_REFERENCED' });
    }
    expect(await w.read<ProcessView>(`/processes/${process.id}`)).toEqual(before);
  });

  it('引用后可以改开启规则细节与名称（🟡 K-24），顺序与开启方式不变', async () => {
    const w = await idpWorld(testDb().db, 'idp03c');
    const process = await w.process();
    await w.template(process.id);
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    const input = asInput(before).map((sub, index) => (index === 2 ? { ...sub, name: '年终回顾', days: 10 } : sub));
    const response = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: before.revision,
      body: { subProcesses: input },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = (await response.json()) as ProcessView;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.subProcesses.map((s) => s.id)).toEqual(before.subProcesses.map((s) => s.id));
    expect(after.subProcesses[2]).toMatchObject({ name: '年终回顾', days: 10, startMode: 'auto' });
    expect(after.subProcesses[2]!.ruleText).toBe('于上一阶段结束时间后10天的凌晨2点自动开启');
  });

  it('未被引用的流程可以调整顺序与开启方式', async () => {
    const w = await idpWorld(testDb().db, 'idp03d');
    const process = await w.process();
    expect(process.referenced).toBe(false);
    const reordered = asInput(process);
    const swapped = [
      reordered[0]!,
      { ...reordered[2]!, startTimeType: null, referencePoint: null, startFrom: null, days: null },
      reordered[1]!,
    ];
    const response = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: process.revision,
      body: { subProcesses: swapped },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = (await response.json()) as ProcessView;
    expect(after.subProcesses.map((s) => [s.seq, s.name])).toEqual([
      [1, '制定计划'],
      [2, '期末回顾'],
      [3, '中期回顾'],
    ]);
  });

  it('引用它的模板删除后不再算被引用（删除的数据不参与判定），可以调整顺序', async () => {
    const w = await idpWorld(testDb().db, 'idp03f');
    const process = await w.process();
    const template = await w.template(process.id);
    const removed = await w.request('DELETE', `/templates/${template.id}`, { ifMatch: template.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    expect(before.referenced).toBe(false);
    const response = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: before.revision,
      body: { subProcesses: [asInput(before)[0]!, asInput(before)[2]!, asInput(before)[1]!] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('被模板引用的流程不能删除（409），未引用的可以删除', async () => {
    const w = await idpWorld(testDb().db, 'idp03e');
    const used = await w.process();
    await w.template(used.id);
    const before = await w.read<ProcessView>(`/processes/${used.id}`);
    const rejected = await w.request('DELETE', `/processes/${used.id}`, { ifMatch: before.revision });
    expect(rejected.status).toBe(409);
    expect(await reasonOf(rejected)).toEqual({ code: 'CONFLICT', reason: 'IDP_PROCESS_REFERENCED' });
    expect(await w.read<ProcessView>(`/processes/${used.id}`)).toEqual(before);

    const free = await w.process({ name: '未使用流程' });
    const removed = await w.request('DELETE', `/processes/${free.id}`, { ifMatch: free.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const gone = await w.request('GET', `/processes/${free.id}`);
    expect(gone.status).toBe(404);
    expect(await errorCode(gone)).toBe('NOT_FOUND');
  });
});
