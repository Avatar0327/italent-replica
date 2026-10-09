/** F-047 / AC-IDP（补）：28 §1 的子流程结束通知模板配置，复用现有通知模板编码。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpWorld, type ProcessView } from './AC-IDP-support.js';

const testDb = useTestDb();
type NoticeProcess = Omit<ProcessView, 'subProcesses'> & {
  subProcesses: (ProcessView['subProcesses'][number] & { endNoticeTemplate: string | null })[];
};

const inputs = (process: NoticeProcess) => process.subProcesses.map(({ ruleText: _ruleText, ...sub }) => sub);

describe('AC-IDP（补）子流程结束通知模板', () => {
  it('新建、列表、详情、修改、清空及原键重放返回实际模板编码，revision 与幂等冲突不改业务', async () => {
    const w = await idpWorld(testDb().db, 'idp-end-notice');
    let process = (await w.process({
      subProcesses: w.threeStages().map((sub, i) => (i === 0 ? { ...sub, endNoticeTemplate: ' IDP.PlanEnded ' } : sub)),
    })) as NoticeProcess;
    expect(process.subProcesses.map((sub) => sub.endNoticeTemplate)).toEqual(['IDP.PlanEnded', null, null]);
    expect(await w.read<NoticeProcess>(`/processes/${process.id}`)).toEqual(process);
    const list = await w.read<{ items: NoticeProcess[] }>('/processes');
    expect(list.items[0]!.subProcesses[0]!.endNoticeTemplate).toBe('IDP.PlanEnded');
    // 已被模板引用仍允许调整通知模板（IDP-R5 只限制顺序 / 开启方式）。
    await w.template(process.id);
    process = await w.read<NoticeProcess>(`/processes/${process.id}`);
    const request = {
      ifMatch: process.revision,
      idempotencyKey: 'end-notice-update',
      body: {
        subProcesses: inputs(process).map((sub, i) => (i === 0 ? { ...sub, endNoticeTemplate: 'IDP.Done' } : sub)),
      },
    };
    const saved = await w.request('PATCH', `/processes/${process.id}`, request);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const updated = (await saved.json()) as NoticeProcess;
    expect(updated.revision).toBe(process.revision + 1);
    expect(updated.subProcesses[0]!.endNoticeTemplate).toBe('IDP.Done');
    const replay = await w.request('PATCH', `/processes/${process.id}`, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(updated);
    const conflict = await w.request('PATCH', `/processes/${process.id}`, {
      ...request,
      body: { subProcesses: inputs(updated) },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const stale = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: process.revision,
      body: { subProcesses: inputs(updated) },
    });
    expect(stale.status).toBe(409);
    expect(await w.read<NoticeProcess>(`/processes/${process.id}`)).toEqual(updated);
    const cleared = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: updated.revision,
      body: { subProcesses: inputs(updated).map((sub) => ({ ...sub, endNoticeTemplate: null })) },
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as NoticeProcess).subProcesses[0]!.endNoticeTemplate).toBeNull();
  });

  it('旧客户端整组更新省略结束通知模板时保留已保存值', async () => {
    const w = await idpWorld(testDb().db, 'idp-end-legacy');
    const process = (await w.process({
      subProcesses: [{ ...w.threeStages()[0], endNoticeTemplate: 'IDP.Keep' }],
    })) as NoticeProcess;
    const subProcesses = inputs(process).map(({ endNoticeTemplate: _template, ...sub }) => ({
      ...sub,
      name: '新名称',
    }));
    const response = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: process.revision,
      body: { subProcesses },
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as NoticeProcess;
    expect(updated.subProcesses[0]).toMatchObject({ name: '新名称', endNoticeTemplate: 'IDP.Keep' });
    expect(await w.read<NoticeProcess>(`/processes/${process.id}`)).toEqual(updated);
  });

  it('模板编码只接受非空的有界文本或 null，非法输入 400 且前后数据相等', async () => {
    const w = await idpWorld(testDb().db, 'idp-end-invalid');
    const process = (await w.process()) as NoticeProcess;
    for (const value of ['', '   ', 'x'.repeat(201), 1, { channel: 'email' }]) {
      const before = await w.read<NoticeProcess>(`/processes/${process.id}`);
      const response = await w.request('PATCH', `/processes/${process.id}`, {
        ifMatch: before.revision,
        body: { subProcesses: inputs(before).map((sub) => ({ ...sub, endNoticeTemplate: value })) },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(await w.read<NoticeProcess>(`/processes/${process.id}`)).toEqual(before);
    }
  });
});
