/**
 * 第 4 轮：转交进入隐藏节点后，详情、任务历史与日志历史三个读取口径同时收紧（DEC-115），
 * 组件交错测试模拟的"迟到宽响应 / 当前隐藏响应"由生产授权器实际产生。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, grantFieldAccess, permissionAdmin, transferScene } from './AC-APV-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
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

describe('AC-APV-UI-02 / DEC-277：字段撤权是收紧信号，而历史分页本身不承载字段', () => {
  it('生产授权器：撤销 place 查看权后完整详情已裁剪，任务 / 日志历史仍 200 且非隐藏（合法真实组合）', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-r5-revoke');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    const profile = await grantFieldAccess(world, s.outHead.userId, {
      view: ['id', 'departmentId', 'effectiveDate', 'place'],
    });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', formFields: ['departmentId', 'place'] },
        { key: 'in_hrbp', approver: 'record_department_hrbp' },
      ],
    });
    let view = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to, place: '合成撤权前可见的工作地点' }),
    );
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
    const before = await w.json<typeof view>(await read(''));
    expect(before.form.values).toMatchObject({ place: '合成撤权前可见的工作地点' });

    // 撤销 place 查看权：完整详情立即裁剪；历史分页不承载表单字段，照常返回且不隐藏。
    const definition = MODULE_OBJECTS.employmentRecord;
    const revoked = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: ['id', 'departmentId', 'effectiveDate'].includes(field.code),
          edit: false,
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const after = await w.json<typeof view>(await read(''));
    expect(after.form.values).not.toHaveProperty('place');
    expect(after.form.values).toMatchObject({ departmentId: s.to });
    expect(after.recordsHidden).toBe(false);
    for (const path of ['/tasks?page=1&pageSize=20', '/logs?page=1&pageSize=20']) {
      const page = await w.json<HistoryPage>(await read(path));
      expect(page.recordsHidden).toBe(false);
      expect(page.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(page)).not.toContain('合成撤权前可见的工作地点');
    }
  });
});

describe('AC-APV-UI-02 / DEC-288：编辑日志承载受权限裁剪的字段名', () => {
  it('生产授权器：本人编辑 place 产生字段名 [place] 的日志；撤销 place 查看权后同一日志字段名裁为空且非隐藏', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-r6-edit-log');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    const profile = await grantFieldAccess(world, s.outHead.userId, {
      view: ['id', 'departmentId', 'effectiveDate', 'place'],
      edit: ['place'],
    });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'place'],
          editableFields: ['place'],
          editMode: 'separate',
        },
        { key: 'in_hrbp', approver: 'record_department_hrbp' },
      ],
    });
    const view = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to, place: '合成编辑前地点' }),
    );
    const [task] = w.pending(view);
    const edited = await api.request('POST', `${BASE}/tasks/${task!.id}/edit`, {
      ...w.as(s.outHead.userId),
      ifMatch: view.revision,
      body: { fields: { place: '合成编辑后地点' } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const read = async (path: string) =>
      api.request('GET', `${BASE}/instances/${view.id}${path}`, w.as(s.outHead.userId));
    const logsOf = async () =>
      await w.json<{ recordsHidden: boolean; items: { id: string; event: string; detail: { fields?: string[] } }[] }>(
        await read('/logs?page=1&pageSize=20'),
      );
    const before = await logsOf();
    const editLog = before.items.find((log) => log.event === 'edit');
    expect(editLog?.detail.fields).toEqual(['place']);
    expect((await w.json<typeof view>(await read(''))).form.values).toMatchObject({ place: '合成编辑后地点' });

    const definition = MODULE_OBJECTS.employmentRecord;
    const revoked = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: ['id', 'departmentId', 'effectiveDate'].includes(field.code),
          edit: false,
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const after = await logsOf();
    expect(after.recordsHidden).toBe(false);
    expect(after.items.find((log) => log.event === 'edit')?.detail.fields).toEqual([]);
    expect(JSON.stringify(after)).not.toContain('合成编辑后地点');
    const detail = await w.json<typeof view>(await read(''));
    expect(detail.form.values).not.toHaveProperty('place');
    expect((detail.logs.find((log) => log.event === 'edit')?.detail as { fields?: string[] }).fields).toEqual([]);
  });
});
