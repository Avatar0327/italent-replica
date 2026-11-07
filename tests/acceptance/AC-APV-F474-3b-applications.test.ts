import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, TRANSFER_NODES, type NodeInput } from './AC-APV-support.js';

const database = useTestDb();
const url = '/api/tenant/approval/instances';
interface Row {
  id: string;
  title: string;
  status: string;
  approvalType: string;
  approvalTypeName: string;
  initiatorName: string;
  currentHandlers: string[];
  createdAt: string;
}
interface Applications {
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
}

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: TRANSFER_NODES });
  const first = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  const other = await w.person('第二位合成人员', s.from);
  const second = await w.submit(await w.application(other.employeeId, { departmentId: s.to }));
  const query = async (userId: string, qs: string) =>
    w.json<Applications>(await w.request(userId, 'GET', `${url}?view=applications${qs}`));
  return { w, s, first, second, query };
}

describe('AC-APV-F474-3b 我的申请列表服务端投影', () => {
  it('每行带发起人姓名、类别名与当前处理人；已结束的申请没有当前处理人', async () => {
    const { w, s, first, second, query } = await scene('f474b-projection');
    const before = await query(w.hr.id, '');
    expect(before.total).toBe(2);
    for (const row of before.items) {
      expect(row.initiatorName).toBe(w.hr.displayName);
      expect(row.approvalTypeName).toBe('调动');
      expect(row.currentHandlers).toEqual([s.outHead.name]);
    }
    const ended = await w.json<{ status: string }>(
      await w.instanceAction(w.hr.id, second.id, 'withdraw', second.revision),
    );
    const after = await query(w.hr.id, '');
    const endedRow = after.items.find((row) => row.id === second.id)!;
    expect(endedRow.status).toBe(ended.status);
    expect(endedRow.currentHandlers).toEqual([]);
    expect(after.items.find((row) => row.id === first.id)!.currentHandlers).toEqual([s.outHead.name]);
  });

  it('类别与审批状态在分页前筛选，总数取同一筛选条件而非当前页', async () => {
    const { w, second, query } = await scene('f474b-filter');
    const ended = await w.json<{ status: string }>(
      await w.instanceAction(w.hr.id, second.id, 'withdraw', second.revision),
    );
    const running = await query(w.hr.id, '&status=running&pageSize=1');
    expect(running).toMatchObject({ total: 1, pageSize: 1 });
    expect(running.items.map((row) => row.status)).toEqual(['running']);
    const both = await query(w.hr.id, `&status=running,${ended.status}&pageSize=1`);
    expect(both.total).toBe(2);
    expect(both.items).toHaveLength(1);
    expect(await query(w.hr.id, '&category=transfer')).toMatchObject({ total: 2 });
    expect(await query(w.hr.id, '&category=transfer,leave&status=approved')).toMatchObject({ items: [], total: 0 });
    expect(await query(w.hr.id, '&category=contract_create')).toMatchObject({ items: [], total: 0 });
    expect(await query(w.hr.id, '&page=9&pageSize=1')).toMatchObject({ items: [], total: 2, page: 9 });
  });

  it('默认按申请时间倒序；审批状态与申请时间可在服务端排序', async () => {
    const { w, first, second, query } = await scene('f474b-sort');
    await w.json(await w.instanceAction(w.hr.id, second.id, 'withdraw', second.revision));
    const ids = (value: Applications) => value.items.map((row) => row.id);
    const byTimeDesc = await query(w.hr.id, '');
    const byTimeAsc = await query(w.hr.id, '&sort=createdAt&order=asc');
    expect(ids(byTimeAsc)).toEqual([...ids(byTimeDesc)].reverse());
    const byStatusAsc = await query(w.hr.id, '&sort=status&order=asc');
    const byStatusDesc = await query(w.hr.id, '&sort=status&order=desc');
    expect(ids(byStatusAsc)).toEqual([...ids(byStatusDesc)].reverse());
    expect(new Set(ids(byStatusAsc))).toEqual(new Set([first.id, second.id]));
    // 排序跨页生效：第一页取到的是排序后的第一条
    const firstPage = await query(w.hr.id, '&sort=status&order=asc&pageSize=1');
    expect(ids(firstPage)).toEqual([ids(byStatusAsc)[0]]);
  });

  it('只返回本人发起的实例：审批人、其他租户、非法条件均不泄露也不改变总数', async () => {
    const { w, s, query } = await scene('f474b-own');
    expect(await query(s.outHead.userId, '')).toMatchObject({ items: [], total: 0 });
    const foreign = await approvalWorld(database().db, 'f474b-foreign');
    const foreignRows = await foreign.json<Applications>(
      await foreign.request(foreign.hr.id, 'GET', `${url}?view=applications`),
    );
    expect(foreignRows).toMatchObject({ items: [], total: 0 });
    const bad = await w.request(w.hr.id, 'GET', `${url}?view=applications&status=nonsense`);
    expect(bad.status).toBe(400);
    const badSort = await w.request(w.hr.id, 'GET', `${url}?view=applications&sort=title`);
    expect(badSort.status).toBe(400);
    const keys = Object.keys((await query(w.hr.id, '')).items[0]!).sort();
    expect(keys).toEqual(
      [
        'approvalType',
        'approvalTypeName',
        'createdAt',
        'currentHandlers',
        'id',
        'initiatorName',
        'status',
        'title',
      ].sort(),
    );
  });

  it('不带 view 的原实例查询保持不变', async () => {
    const { w, first, second } = await scene('f474b-legacy');
    const legacy = await w.json<{ items: Record<string, unknown>[] }>(
      await w.request(w.hr.id, 'GET', `${url}?role=initiated`),
    );
    expect(legacy.items.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(Object.keys(legacy.items[0]!).sort()).toEqual(
      ['approvalType', 'businessId', 'createdAt', 'currentNodeKey', 'id', 'revision', 'status', 'title'].sort(),
    );
  });

  it('P2-1 当前处理人按实例 + 用户去重：同名不同人各保留，同一人多个待办只保留一个', async () => {
    const joint: NodeInput = {
      key: 'joint',
      name: '调入部门会签',
      kind: 'countersign',
      approvers: [
        { type: 'department', value: 'record_department_head' },
        { type: 'department', value: 'record_department_hrbp' },
      ],
    };
    const w = await approvalWorld(database().db, 'f474b-handlers');
    const s = await transferScene(w);
    const first = await w.person('合成同名审批人', s.to);
    const second = await w.person('合成同名审批人', s.to);
    await w.setOrgRoles(s.to, { head: first.employeeId, hrbp: second.employeeId });
    await w.publishedProcess({ nodes: [joint] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const handlers = async () =>
      (await w.json<Applications>(await w.request(w.hr.id, 'GET', `${url}?view=applications`))).items[0]!
        .currentHandlers;
    // 两个不同用户同名：两条待办都要体现，不能被姓名去重吞掉
    expect(view.tasks.filter((task) => task.status === 'pending')).toHaveLength(2);
    expect(await handlers()).toEqual(['合成同名审批人', '合成同名审批人']);
    // 引擎保证一人一票，所以同一用户的多条待办只能由异常数据造出（同 AC-APV-capacity-config 的直接写入做法）：
    // 给第一位再补两条待办，仍只算一个人
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO approval_tasks
        (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,created_at)
        SELECT gen_random_uuid(),${w.tenant.id},${view.id}::uuid,100000+g,1,'joint',${first.userId}::uuid,
          'transfer','pending',now() FROM generate_series(1,2) g`);
    });
    expect(await handlers()).toEqual(['合成同名审批人', '合成同名审批人']);
  });

  it('P2-4 view=applications 严格校验查询键：未知键 400，page / pageSize 与全部合法键照常通过', async () => {
    const { w, query } = await scene('f474b-strict');
    for (const extra of ['&foo=1', '&role=initiated', '&businessId=x', '&Status=running', '&pagesize=1']) {
      const bad = await w.request(w.hr.id, 'GET', `${url}?view=applications${extra}`);
      expect(bad.status, extra).toBe(400);
    }
    const paged = await query(w.hr.id, '&page=1&pageSize=1&category=transfer&status=running&sort=createdAt&order=asc');
    expect(paged).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(paged.items).toHaveLength(1);
    expect(await query(w.hr.id, '&page=2&pageSize=1')).toMatchObject({ total: 2, page: 2 });
  });
});
