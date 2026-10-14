/**
 * F-141 第 4 轮（DEC-385③）：F-123 内核冲突恢复的共同契约，所有接入方（目录页 ResourceForm、useRecordForm 的评定 / 360 表单）共用。
 * 内核拿完整字段投影：基线（打开时的记录）、草稿、重读得到的最新记录三者字段集合一致；
 * - 改过的字段只按“草稿 vs 基线”算；409 重读后没改过的字段回填最新值，改过的保留草稿；
 * - 重提的命令体只含改过的字段，版本是最新版本，幂等键换新命令。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Command } from '../../apps/web/src/foundation/client.js';
import { createFormStore, type Values } from '../../apps/web/src/foundation/forms/store.js';

const conflict = () => new ApiError(409, 'REVISION_CONFLICT', 'refresh', '版本已变化');
const open: Values = { id: 'r1', name: 'A', code: 'K1', note: '备注' };
const editable = ['name', 'code', 'note'];
const reread = (latest: Values & { revision: number }) => async () => ({
  id: 'r1',
  revision: latest.revision,
  values: latest,
});

describe('AC-F141-form-kernel-recovery 冲突恢复（完整字段投影）', () => {
  it('只改名称，他人改了编码：重读后编码回填最新值，重提只带名称、版本为最新', async () => {
    const store = createFormStore();
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>().mockRejectedValueOnce(conflict());
    send.mockResolvedValue({ id: 'r1' });
    const first = await store.submit('k', {
      values: { name: 'B', code: 'K1', note: '备注' },
      baseline: open,
      editableFields: editable,
      revision: 1,
      businessId: 'r1',
      patchOnly: true,
      send,
    });
    expect(first.status).toBe('conflict');
    expect(send.mock.calls[0]![0]).toMatchObject({ revision: 1, body: { name: 'B' } });

    await store.reread('k', reread({ id: 'r1', revision: 2, name: 'A', code: 'K2', note: '备注' }));
    const reread1 = store.get('k')!;
    // 三列：基线 K1、最新 K2、我的输入 = 基线（没改）；表单回填最新值
    expect(reread1.differences).toEqual([{ field: 'code', before: 'K1', latest: 'K2', mine: 'K1' }]);
    expect(reread1.values).toMatchObject({ name: 'B', code: 'K2' });
    store.confirm('k');

    await store.submit('k', {
      values: { ...store.get('k')!.values },
      baseline: open,
      editableFields: editable,
      revision: 1,
      businessId: 'r1',
      patchOnly: true,
      send,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ revision: 2, body: { name: 'B' } });
    expect(Object.keys(send.mock.calls[1]![0].body as object)).toEqual(['name']);
    expect(send.mock.calls[1]![0].id).not.toBe(send.mock.calls[0]![0].id);
  });

  it('改过的字段保留草稿：他人也改了同一字段，我的输入仍是草稿；改回原值也会发出（最新值不同）', async () => {
    const store = createFormStore();
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>().mockRejectedValueOnce(conflict());
    send.mockResolvedValue({ id: 'r1' });
    const input = (values: Values) => ({
      values,
      baseline: open,
      editableFields: editable,
      revision: 1,
      businessId: 'r1',
      patchOnly: true,
      send,
    });
    await store.submit('k', input({ name: 'B', code: 'K1', note: '备注' }));
    await store.reread('k', reread({ id: 'r1', revision: 2, name: 'C', code: 'K1', note: '备注' }));
    expect(store.get('k')!.differences).toEqual([{ field: 'name', before: 'A', latest: 'C', mine: 'B' }]);
    store.confirm('k');
    await store.submit('k', input({ ...store.get('k')!.values, name: 'A' }));
    expect(send.mock.calls[1]![0]).toMatchObject({ revision: 2, body: { name: 'A' } });
    expect(Object.keys(send.mock.calls[1]![0].body as object)).toEqual(['name']);
  });
});

describe('AC-F141-form-kernel-recovery 空值表示统一（第 5 轮）', () => {
  const run = async (baseline: Values, draft: Values, latest: Values & { revision: number }) => {
    const store = createFormStore();
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>().mockRejectedValueOnce(conflict());
    send.mockResolvedValue({ id: 'r1' });
    const fields = Object.keys(baseline).filter((key) => key !== 'id');
    const input = (values: Values) => ({
      values,
      baseline,
      editableFields: fields,
      revision: 1,
      businessId: 'r1',
      patchOnly: true,
      send,
    });
    await store.submit('k', input(draft));
    const firstBody = send.mock.calls[0]![0].body as Values;
    await store.reread('k', async () => ({ id: 'r1', revision: latest.revision, values: latest }));
    store.confirm('k');
    return { firstBody, state: store.get('k')!, store };
  };

  it('选了又清回原空值（undefined / null / 空串 / 空数组互相等价）算未改：不进命令体，重读后回填最新值', async () => {
    // 字段类型：单选引用 layerId、文本 note、多选 tags、数字 order、开关 flag（false 是有效值，不算空）
    const baseline: Values = { id: 'r1', name: 'A', layerId: null, note: null, tags: null, order: null, flag: false };
    const draft: Values = { name: 'B', layerId: undefined, note: '', tags: [], order: undefined, flag: false };
    const latest = {
      id: 'r1',
      revision: 2,
      name: 'A',
      layerId: 'L2',
      note: '备注',
      tags: ['t'],
      order: 5,
      flag: false,
    };
    const { firstBody, state } = await run(baseline, draft, latest);
    expect(Object.keys(firstBody)).toEqual(['name']);
    expect(state.values).toMatchObject({ name: 'B', layerId: 'L2', note: '备注', tags: ['t'], order: 5 });
    expect(state.differences?.map((d) => d.field).sort()).toEqual(['layerId', 'note', 'order', 'tags']);
  });

  it('有意义的值不被当成空：0、false 与空值不同；非空改成空算改过', async () => {
    const baseline: Values = { id: 'r1', order: 0, flag: false, layerId: 'L1', tags: ['t'] };
    const { firstBody } = await run(
      baseline,
      { order: undefined, flag: undefined, layerId: undefined, tags: [] },
      {
        id: 'r1',
        revision: 2,
        order: 0,
        flag: false,
        layerId: 'L1',
        tags: ['t'],
      },
    );
    expect(Object.keys(firstBody).sort()).toEqual(['flag', 'layerId', 'order', 'tags']);
  });
});
