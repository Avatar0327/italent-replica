/**
 * 第 4 轮：转交进入隐藏节点后，详情、任务历史与日志历史三个读取口径同时收紧（DEC-115），
 * 组件交错测试模拟的"迟到宽响应 / 当前隐藏响应"由生产授权器实际产生。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, grantFieldAccess, permissionAdmin, transferScene } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const COMMENT = '合成第一节点意见，转交进入隐藏节点后不得再出现';

interface HistoryPage {
  readonly recordsHidden: boolean;
  readonly items: readonly { readonly status?: string; readonly comment?: string | null }[];
}

describe('AC-APV-UI-02 / DEC-115：转交进入隐藏节点后三个读取口径同时收紧', () => {
  it('生产授权器：转交进入隐藏节点后，详情、任务历史与日志历史同时返回 recordsHidden 且不含此前意见', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-r4-hidden');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    for (const userId of [s.outHead.userId, s.inHrbp.userId])
      await grantFieldAccess(world, userId, { view: ['id', 'departmentId', 'effectiveDate'] });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head' },
        { key: 'hidden', approver: 'record_department_hrbp', hideRecords: true, actions: { transfer: true } },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const [first] = w.pending(view);
    view = await w.json(
      await api.request('POST', `${BASE}/tasks/${first!.id}/approve`, {
        ...w.as(s.outHead.userId),
        ifMatch: view.revision,
        body: { comment: COMMENT },
      }),
    );
    const read = async (path: string) =>
      api.request('GET', `${BASE}/instances/${view.id}${path}`, w.as(s.outHead.userId));
    const page = async (path: string) => w.json<HistoryPage>(await read(path));

    // 转交前：U 处理过普通节点，详情与两种历史都可见本人意见。
    const before = await w.json<typeof view>(await read(''));
    expect(before.recordsHidden).toBe(false);
    expect(JSON.stringify(before)).toContain(COMMENT);
    const tasksBefore = await page('/tasks?page=1&pageSize=20');
    expect(tasksBefore.recordsHidden).toBe(false);
    expect(tasksBefore.items.some((task) => task.comment === COMMENT)).toBe(true);
    const logsBefore = await page('/logs?page=1&pageSize=20');
    expect(logsBefore.recordsHidden).toBe(false);
    expect(JSON.stringify(logsBefore)).toContain(COMMENT);

    // V 把隐藏节点的任务转交给 U：U 从此参与隐藏节点，三个口径同时收紧。
    const [hiddenTask] = w.pending(view);
    expect(hiddenTask!.assigneeUserId).toBe(s.inHrbp.userId);
    const transferred = await w.json<typeof view>(
      await api.request('POST', `${BASE}/tasks/${hiddenTask!.id}/transfer`, {
        ...w.as(s.inHrbp.userId),
        ifMatch: view.revision,
        body: { toUserId: s.outHead.userId },
      }),
    );
    expect(transferred.status).toBe('running');
    const after = await w.json<typeof view>(await read(''));
    expect(after).toMatchObject({ recordsHidden: true, logs: [] });
    expect(after.tasks.every((task) => task.status === 'pending')).toBe(true);
    expect(JSON.stringify(after)).not.toContain(COMMENT);
    for (const path of ['/tasks?page=1&pageSize=20', '/logs?page=1&pageSize=20']) {
      const hidden = await page(path);
      expect(hidden.recordsHidden).toBe(true);
      expect(hidden.items.every((item) => item.status === 'pending')).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain(COMMENT);
    }
  });
});
