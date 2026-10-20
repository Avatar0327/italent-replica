/**
 * R2-T04 BE-5d2 / AC-RT-20b：意向申请读写范围分离（设计 §11.1，P1-1）。
 * 夹具：申请时员工在部门 B（快照 B），之后调入 A；HR 只有 A 的组织范围，持 Employment.RetireIntention 与字段权。
 * 读（DEC-177）：员工当前部门或申请快照部门任一在范围内即可见；写（DEC-193）：坐标取申请行自己的快照部门 / 员工 / 发起人，
 * 不随查看范围放宽——被拒时申请行、审批实例、审计、命令台账前后逐项相等。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf } from './AC-RT-intention-support.js';
import { realUser, setRecordScopeRules } from './AC-RT-intention-real-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => intentionWorld(database().db, `${label}-${uniqueSuffix()}`);
const APPROVAL = '/api/tenant/approval';

describe('AC-RT-20b 读写范围分离', () => {
  it('①读：当前部门 A 命中即可见；②写：快照部门 B 不在范围，PATCH / 撤回 / 审批中心撤回都被拒且前后相等；③再获 B 后成功', async () => {
    const w = await world('split');
    const operator = await realUser(w, 'HR操作人', { orgIds: [w.deptB] });
    const second = await w.person('第二个员工', w.deptB, { directManagerId: w.manager.employeeId });

    // 申请时员工在 B：操作人创建并提交（实例发起人 = 操作人），再创建第二张草稿
    const revision = (
      await w.json<{ revision: number }>(
        await w.request(w.hr.id, 'GET', `${'/api/tenant/employment'}/employees/${w.subject.employeeId}`),
      )
    ).revision;
    const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
      ifMatch: revision,
      body: { intendedDate: '2030-03-01' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const inReview = (await created.json()) as { id: string; revision: number };
    const sent = await operator.call('POST', `/retirement-intentions/${inReview.id}/submit`, {
      ifMatch: inReview.revision,
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const secondRevision = await w.revisionOf(second.employeeId);
    const draftResponse = await operator.call('POST', `/retirement-intentions/employees/${second.employeeId}`, {
      ifMatch: secondRevision,
      body: { intendedDate: '2030-03-02' },
    });
    expect(draftResponse.status, await draftResponse.clone().text()).toBe(201);
    const draft = (await draftResponse.json()) as { id: string; revision: number };
    const instance = await w.instance(inReview.id, operator.userId);

    // 两名员工调入 A；操作人的范围收窄为只有 A
    await w.transferTo(w.deptA);
    await w.transferTo(w.deptA, second.employeeId);
    await operator.setScope([w.deptA]);

    // ① 读：详情与列表都可读（员工当前部门 A 命中）
    for (const id of [inReview.id, draft.id]) {
      const detail = await operator.call('GET', `/retirement-intentions/${id}`);
      expect(detail.status, await detail.clone().text()).toBe(200);
    }
    const listed = (await (await operator.call('GET', '/retirement-intentions')).json()) as {
      items: { id: string }[];
      total: number;
    };
    expect(listed.items.map((item) => item.id).sort()).toEqual([inReview.id, draft.id].sort());
    expect(listed.total).toBe(2);

    // ② 写：全部被拒（404 不泄露存在性），申请行 / 审批实例 / 审计 / 命令台账前后逐项相等
    const before = { x: await w.footprint(inReview.id), y: await w.footprint(draft.id) };
    const denied = [
      await operator.call('PATCH', `/retirement-intentions/${draft.id}`, {
        ifMatch: draft.revision,
        body: { reason: '改' },
      }),
      await operator.call('POST', `/retirement-intentions/${draft.id}/withdraw`, { ifMatch: draft.revision }),
      await operator.call('POST', `/retirement-intentions/${draft.id}/submit`, { ifMatch: draft.revision }),
      await operator.call('POST', `/retirement-intentions/${inReview.id}/withdraw`, { ifMatch: inReview.revision + 1 }),
      await operator.call('POST', `${APPROVAL}/instances/${instance.id}/withdraw`, {
        ifMatch: instance.revision,
        body: {},
      }),
    ];
    for (const response of denied) {
      expect([403, 404], await response.clone().text()).toContain(response.status);
    }
    expect((await reasonOf(denied[0]!.clone())).code).toBe('NOT_FOUND');
    expect({ x: await w.footprint(inReview.id), y: await w.footprint(draft.id) }).toEqual(before);

    // ③ 对照：同一 HR 再获 B 的范围后同样操作成功
    await operator.setScope([w.deptA, w.deptB]);
    const patched = await operator.call('PATCH', `/retirement-intentions/${draft.id}`, {
      ifMatch: draft.revision,
      body: { reason: '改' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const withdrawn = await operator.call('POST', `${APPROVAL}/instances/${instance.id}/withdraw`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect((await w.get(inReview.id)).status).toBe('withdrawn');
  });

  it('④ “使用用户”维度：他人发起的申请读、写都被拒；自己发起的可读可写', async () => {
    const w = await world('using-user');
    await setRecordScopeRules(w, ['using_user']);
    const operator = await realUser(w, '使用用户HR');
    // 他人发起：管理员为 subject 建的申请；本人发起：操作人建的员工主档（使用用户维度的创建人）上的申请
    const other = await w.create({ intendedDate: '2030-03-01' });
    const mine = await w.personCreatedBy(operator.userId, '本人创建的员工', w.deptB, {
      directManagerId: w.manager.employeeId,
    });
    const own = await operator.call('POST', `/retirement-intentions/employees/${mine.employeeId}`, {
      ifMatch: await w.revisionOf(mine.employeeId),
      body: { intendedDate: '2030-03-02' },
    });
    expect(own.status, await own.clone().text()).toBe(201);
    const ownIntention = (await own.json()) as { id: string; revision: number };

    const before = await w.footprint(other.id);
    expect((await operator.call('GET', `/retirement-intentions/${other.id}`)).status).toBe(404);
    const foreignWrite = await operator.call('PATCH', `/retirement-intentions/${other.id}`, {
      ifMatch: other.revision,
      body: { reason: '越权' },
    });
    expect(foreignWrite.status).toBe(404);
    expect(await w.footprint(other.id)).toEqual(before);
    const listed = (await (await operator.call('GET', '/retirement-intentions')).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual([ownIntention.id]);

    expect((await operator.call('GET', `/retirement-intentions/${ownIntention.id}`)).status).toBe(200);
    const ownWrite = await operator.call('PATCH', `/retirement-intentions/${ownIntention.id}`, {
      ifMatch: ownIntention.revision,
      body: { reason: '本人改' },
    });
    expect(ownWrite.status, await ownWrite.clone().text()).toBe(200);
  });
});
