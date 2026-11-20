import { withTenant, sql } from '@italent/db';
import { renderEsignNotice } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runESignJobs } from '../../apps/api/src/modules/esign/scheduler.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { DAY, NOTICE, SCENES, START, sharedWorld, type Task } from './AC-ESIGN-F505-s2-support.js';
import { rowsOf } from './AC-ESIGN-F505-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
const names = { offer: 'Offer电子签署', entry: '入职电子签署' };
type Notice = { template: string; title: string; body: string; sender: string | null; businessId: string };

it.each(SCENES)('AC-08 %s 本人及发起人顺签，来源不写回，审计记录正确来源', async (scene) => {
  const w = await sharedWorld(db().db, `flow-${scene}`);
  const task = await w.fixture(scene, await w.template());
  const before = await w.business(task);
  const outsider = await w.member();
  await reason(await w.sign(w.userId, task), 'ESIGN_NODE_NOT_READY');
  await reason(await w.sign(outsider.user.id, task), 'NOT_FOUND', 404);
  expect(await json(await w.call('GET', `/mine/${task.id}`, { user: w.employeeUser }))).toMatchObject({
    scene,
    currentNode: 'employee',
    canSign: true,
  });
  const ready = await json<Task>(await w.sign(w.employeeUser, task));
  expect(ready).toMatchObject({ status: 'signing', currentNode: 'enterprise', revision: 2 });
  expect(await w.notices()).toEqual([]);
  const completed = await json<Task>(await w.sign(w.userId, ready));
  expect(completed).toMatchObject({ status: 'completed', currentNode: null, revision: 3 });
  expect(await w.business(task)).toEqual(before);
  const audit = await withTenant(w.db, w.tenantId, async (tx) =>
    rowsOf<{ after: object }>(
      await tx.execute(sql`
    SELECT after FROM audit_events WHERE tenant_id=${w.tenantId} AND object_id=${task.id}
      AND action='esign.task.completed'
  `),
    ),
  );
  expect(audit[0]?.after).toMatchObject({
    scene,
    sourceRevision: task.sourceRevision,
    ...(scene === 'offer' ? { offerId: task.offerId } : { businessId: task.businessId }),
  });
  if (scene === 'offer') expect(audit[0]?.after).not.toHaveProperty('businessId');
});

it.each(SCENES)('AC-10 %s 三条生产路径只向当前接收人投递最小正文，重放不重复', async (scene) => {
  const w = await sharedWorld(db().db, `privacy-${scene}`);
  const name = `ZZ_F505_EMP_privacy-${scene}`;
  const selected = await w.template('ZZ_F505_静态正文', 'ZZ_F505_文件名不可进入通知');
  const task = await w.fixture(scene, selected, true);
  expect(await w.notices()).toEqual([]);
  const employeeRemindKey = uniqueSuffix();
  await json(await w.action('remind', task, employeeRemindKey));
  await json(await w.action('remind', task, employeeRemindKey));
  expect((await w.notices()).map(({ template, recipient }) => [template, recipient])).toEqual([
    ['esign_remind', w.employeeUser],
  ]);

  const at = new Date(START.getTime() + DAY);
  expect(await runESignJobs(w.db, { clock: () => new Date(at.getTime() - 1) })).toMatchObject({ reminded: 0 });
  expect(await runESignJobs(w.db, { clock: () => at })).toMatchObject({ reminded: 1 });
  expect(await runESignJobs(w.db, { clock: () => at })).toMatchObject({ reminded: 0 });
  w.setNow(at);
  const ready = await json<Task>(await w.sign(w.employeeUser, await w.taskRow(task.id)));
  expect(await w.notices()).toHaveLength(2);
  const remindKey = uniqueSuffix();
  await json(await w.action('remind', ready, remindKey));
  await json(await w.action('remind', ready, remindKey));
  const signKey = uniqueSuffix();
  await json(await w.sign(w.userId, ready, signKey));
  await json(await w.sign(w.userId, ready, signKey));

  const revoked = await w.fixture(scene, selected);
  const revokeKey = uniqueSuffix();
  await json(await w.action('revoke', revoked, revokeKey));
  await json(await w.action('revoke', revoked, revokeKey));

  const restricted = w.restricted((q) => !q.resource?.startsWith('TenantBase.Employee'));
  const get = async (user: string) =>
    (await json<{ items: Notice[] }>(await restricted('GET', NOTICE, { user }))).items;
  const initiator = await get(w.userId);
  const employee = await get(w.employeeUser);
  const terminal = initiator.filter((n) => n.template !== 'esign_remind');
  expect(JSON.stringify(terminal), '发起人的完成及撤销通知不得出现人员现名').not.toContain(name);
  expect(JSON.stringify(initiator)).not.toContain(selected.name);
  expect(JSON.stringify(employee)).not.toContain(selected.name);
  expect(JSON.stringify(employee)).not.toContain(name);
  const recipientTemplates = (role: string) =>
    ['esign_remind', `esign_completed_${role}`, `esign_revoked_${role}`].sort();
  expect(initiator.map((n) => n.template).sort()).toEqual(recipientTemplates('initiator'));
  expect(employee.map((n) => n.template).sort()).toEqual([...recipientTemplates('employee'), 'esign_remind'].sort());
  for (const item of [...initiator, ...employee]) {
    expect(item.sender).toBeNull();
    expect(item).not.toHaveProperty('payload');
    const label = `${names[scene]}任务（${item.businessId}）`;
    const body = item.template.includes('revoked')
      ? `${label}已撤销。`
      : item.template.includes('completed')
        ? `${label}已完成，请到“我的签署”查看。`
        : `您有一项${label}待处理，请到“我的签署”查看。`;
    expect(item.body).toBe(body);
  }
  const rows = await w.notices();
  expect(rows).toHaveLength(7);
  for (const row of rows) expect(row.payload).toEqual({ scene, taskNumber: row.taskId });
  const other = await w.member();
  expect(await get(other.user.id)).toEqual([]);
});

it('AC-10 声明新场景的畸形通知保留标题且不回退人员字段', () => {
  expect(
    renderEsignNotice('esign_revoked_initiator', {
      scene: 'offer',
      taskNumber: 'ZZ_F505_无效编号',
      员工姓名: 'ZZ_F505_员工',
      场景: '调动电子签署',
      文件名称: 'ZZ_F505_模板',
    }),
  ).toEqual({ title: '电子签署已撤销', body: null });
});
