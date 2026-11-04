import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, grantFieldAccess, permissionAdmin, transferScene } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const base = '/api/tenant/approval/todos';
interface Cards {
  items: { id: string; initiatorName: string | null; summary: { key: string; label: string; value: string }[] }[];
  total: number;
  categories: { key: string; label: string; count: number }[];
}

describe('AC-APV-F474-3 待办卡片服务端投影与计数', () => {
  it('待处理、已处理、已申请分别按本人关系查询；总数不取当前页，原实例查询保持不变', async () => {
    const w = await approvalWorld(database().db, 'f474-cards');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'review',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['effectiveDate', 'departmentId'],
        },
      ],
    });
    const first = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const other = await w.person('第二位合成人员', s.from);
    const second = await w.submit(await w.application(other.employeeId, { departmentId: s.to }));
    const original = await w.json(await w.request(w.hr.id, 'GET', '/api/tenant/approval/instances?role=initiated'));
    // 直接通过 HTTP 验证；空集和越过最后一页仍保持服务端总数。
    const pending = await w.json<Cards>(await w.request(s.outHead.userId, 'GET', `${base}?view=pending&pageSize=1`));
    expect(pending.total).toBe(2);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]!.initiatorName).toBe(w.hr.displayName);
    expect(pending.items[0]!.summary).toContainEqual({ key: 'effectiveDate', label: '调动日期', value: '2026-10-01' });
    expect(pending.categories.find((c) => c.key === 'employment')?.count).toBe(2);
    expect(pending.categories.reduce((n, c) => n + c.count, 0)).toBe(pending.total);
    const beyond = await w.json<Cards>(
      await w.request(s.outHead.userId, 'GET', `${base}?view=pending&page=9&pageSize=1`),
    );
    expect(beyond).toMatchObject({ items: [], total: 2, categories: pending.categories });
    const outsider = await w.member('未参与的合成用户');
    const empty = await w.json<Cards>(await w.request(outsider, 'GET', `${base}?view=pending`));
    expect(empty).toMatchObject({ items: [], total: 0 });
    expect(empty.categories.every((c) => c.count === 0)).toBe(true);
    const filtered = await w.json<Cards>(
      await w.request(s.outHead.userId, 'GET', `${base}?view=pending&category=offer`),
    );
    expect(filtered).toMatchObject({ items: [], total: 0 });
    expect(filtered.categories.every((c) => c.count === 0)).toBe(true);
    const initiated = await w.json<Cards>(await w.request(w.hr.id, 'GET', `${base}?view=initiated`));
    expect(initiated.items.map((i) => i.id).sort()).toEqual([first.id, second.id].sort());
    expect(await w.json(await w.request(w.hr.id, 'GET', '/api/tenant/approval/instances?role=initiated'))).toEqual(
      original,
    );
    const task = first.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, task.id, 'approve', first.revision));
    const completed = await w.json<Cards>(await w.request(s.outHead.userId, 'GET', `${base}?view=completed`));
    expect(completed.total).toBe(1);
    expect(completed.items.map((i) => i.id)).toEqual([first.id]);
    const foreign = await approvalWorld(database().db, 'f474-foreign');
    const foreignCards = await foreign.json<Cards>(
      await foreign.request(foreign.hr.id, 'GET', `${base}?view=initiated`),
    );
    expect(foreignCards).toMatchObject({ items: [], total: 0 });
  });

  it('任一参与节点隐藏则历史分页与分类总数均过滤；当前待办保留，摘要遵守真实权限与节点表单交集', async () => {
    const w = await approvalWorld(database().db, 'f474-hidden');
    const s = await transferScene(w);
    await w.publishedProcess({
      hideRecordsFromInitiator: true,
      nodes: [
        {
          key: 'first',
          approver: { type: 'department', value: 'latest_record_department_head' },
          hideRecords: true,
          formFields: ['departmentId'],
        },
        { key: 'next', approver: { type: 'department', value: 'record_department_head' } },
      ],
    });
    const instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: ['departmentId'] });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const pending = await w.json<Cards>(await api.request('GET', `${base}?view=pending`, w.as(s.outHead.userId)));
    expect(pending.total).toBe(1);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]!.summary.some((f) => f.key === 'effectiveDate')).toBe(false);
    expect(JSON.stringify(pending.items[0]!.summary)).not.toContain('2026-10-01');
    const initiated = await w.json<Cards>(await w.request(w.hr.id, 'GET', `${base}?view=initiated`));
    expect(initiated).toMatchObject({ items: [], total: 0 });
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision));
    const hidden = await w.json<Cards>(await w.request(s.outHead.userId, 'GET', `${base}?view=completed&pageSize=1`));
    expect(hidden).toMatchObject({ items: [], total: 0 });
    expect(hidden.categories.every((c) => c.count === 0)).toBe(true);
  });
});
