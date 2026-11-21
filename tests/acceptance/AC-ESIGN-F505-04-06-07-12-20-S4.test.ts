import { randomUUID } from 'node:crypto';
import { esignTaskFiles, esignTasks, eq, offers, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { DAY, ESIGN, START } from './AC-ESIGN-F505-s2-support.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import {
  contextPath,
  EMPLOYEE,
  offerSigningWorld,
  OFFERS,
  OFFER_OBJECT,
  type Receipt,
  resultPath,
  taskPath,
} from './AC-ESIGN-F505-S4-support.js';

const db = useTestDb();

it('AC-04 只有已接受和已入职可发起，无关联不创建账号、任职或签署任务', async () => {
  const w = await offerSigningWorld(db().db, 'S4_ELIGIBILITY');
  const template = await w.template();
  for (const approvalStatus of ['unsubmitted', 'approved']) {
    const pending = await w.offer({ status: 'pending', approvalStatus });
    await reason(await w.post(pending, [template.id]), 'ESIGN_SOURCE_UNAVAILABLE', 409);
  }
  for (const status of ['sent', 'rejected', 'invalid'] as const) {
    await reason(await w.post(await w.offer({ status }), [template.id]), 'ESIGN_SOURCE_UNAVAILABLE', 409);
  }
  const noOwner = await w.offer({ linkedEmployeeId: null });
  const snapshot = () =>
    w.inTenant((tx) =>
      tx.execute(sql`
    SELECT (SELECT count(*) FROM tenant_memberships) AS members,
           (SELECT count(*) FROM employment_business_objects) AS businesses,
           (SELECT count(*) FROM esign_tasks) AS tasks
  `),
    );
  const before = await snapshot();
  expect(await json(await w.access()('GET', contextPath(noOwner)))).toMatchObject({
    sourceId: noOwner,
    revision: 1,
    canInitiate: false,
    reason: 'ESIGN_OWNER_UNAVAILABLE',
  });
  await reason(await w.post(noOwner, [template.id]), 'ESIGN_OWNER_UNAVAILABLE', 409);
  expect(await snapshot()).toEqual(before);
  const hired = await w.hire('ZZ_F505_同步人员');
  for (const source of [
    await w.offer({ linkedEmployeeId: hired.employeeId }),
    await w.offer({ linkedEmployeeId: null, pendingEntryBusinessId: hired.hire.id }),
    await w.offer({ status: 'onboarded', linkedEmployeeId: hired.employeeId, pendingEntryBusinessId: hired.hire.id }),
  ]) {
    const receipt = await json<Receipt>(await w.post(source, [template.id]), 201);
    expect(await w.taskRow(receipt.taskId)).toMatchObject({
      offerId: source,
      businessId: null,
      employeeId: hired.employeeId,
      employeeSignerUserId: hired.employeeUser,
      ownerDepartmentId: w.from.id,
      sourceRevision: 1,
    });
  }
  const conflict = await w.offer({ pendingEntryBusinessId: hired.hire.id });
  await reason(await w.post(conflict, [template.id]), 'ESIGN_SOURCE_UNAVAILABLE', 409);
});

it('AC-04/20 服务端行操作依赖状态与编辑开关，仅 Offer.update 即可取选项和发起', async () => {
  const w = await offerSigningWorld(db().db, 'S4_ACTION');
  const template = await w.template();
  const source = await w.offer();
  const pending = await w.offer({ status: 'pending' });
  const read = (id: string, call = w.access()) =>
    call('GET', `${OFFERS}/${id}`).then((r) => json<{ rowActions: { menu: string[] } }>(r));
  expect((await read(source)).rowActions.menu).toContain('sign');
  const list = await json<{ items: { id: string; rowActions: { menu: string[] } }[] }>(
    await w.access()('GET', `${OFFERS}?view=accepted`),
  );
  expect(list.items.find((item) => item.id === source)?.rowActions.menu).toContain('sign');
  expect((await read(pending)).rowActions.menu).not.toContain('sign');
  const viewOnly = w.access({ deny: (q) => q.action === 'object.update' });
  expect((await read(source, viewOnly)).rowActions.menu).not.toContain('sign');
  await reason(await viewOnly('GET', contextPath(source)), 'FORBIDDEN', 403);
  const updateOnly = w.access({
    deny: (q) => !!q.resource && !(q.resource === OFFER_OBJECT && q.action === 'object.update'),
  });
  expect(await json(await updateOnly('GET', contextPath(source)))).toEqual({
    sourceId: source,
    revision: 1,
    canInitiate: true,
    items: [{ id: template.id, name: template.name }],
  });
  const entryPath = `/api/tenant/employment/pending-entries/${(await w.hire('ZZ_F505_入职')).hire.id}/esign-context`;
  expect([403, 404]).toContain((await updateOnly('GET', entryPath)).status);
  await json(await w.post(source, [template.id], undefined, 1, updateOnly), 201);
});

it('AC-06 模板选项按租户和变量过滤，提交重新校验启停、变量与模板 ID 集合', async () => {
  const w = await offerSigningWorld(db().db, 'S4_TEMPLATES');
  const source = await w.offer();
  const common = await w.template('{员工姓名}{工号}{发起日期}{企业名称}', 'ZZ_F505_B');
  const text = await w.template('ZZ_F505_正文', 'ZZ_F505_A');
  const transfer = await w.template('{调入部门}', 'ZZ_F505_C');
  const disabled = await w.template('ZZ_F505_正文', 'ZZ_F505_D');
  await w.patchTemplate(disabled.id, { status: 'disabled' });
  const other = await seedTenantWithMember(db().db, 'ZZ_F505_OTHER');
  const foreign = await json<{ id: string }>(
    await tenantApi(db().db).request('POST', `${ESIGN}/templates`, {
      tenant: other.tenant.id,
      user: other.user.id,
      body: { code: uniqueSuffix(), name: 'ZZ_F505_外租户', body: 'ZZ_F505_正文' },
    }),
    201,
  );
  expect(await json(await w.access()('GET', contextPath(source)))).toEqual({
    sourceId: source,
    revision: 1,
    canInitiate: true,
    items: [
      { id: text.id, name: text.name },
      { id: common.id, name: common.name },
    ],
  });
  for (const ids of [[], [text.id, text.id.toUpperCase()], Array.from({ length: 21 }, () => randomUUID())]) {
    await reason(await w.post(source, ids), 'VALIDATION_FAILED', 400);
  }
  for (const id of [disabled.id, foreign.id]) {
    await reason(await w.post(source, [text.id, id]), 'ESIGN_TEMPLATE_UNAVAILABLE', 400);
  }
  await w.patchTemplate(text.id, { status: 'disabled' });
  await reason(await w.post(source, [text.id]), 'ESIGN_TEMPLATE_UNAVAILABLE', 400);
  await w.patchTemplate(common.id, { body: '{调入部门}' });
  for (const id of [common.id, transfer.id])
    await reason(await w.post(source, [id]), 'ESIGN_TEMPLATE_INCOMPATIBLE', 400);
  expect(await w.taskCount()).toBe(0);
});

it('AC-07 人员变量分别检查 name、code 与范围，正文按提交时快照', async () => {
  const w = await offerSigningWorld(db().db, 'S4_VARIABLES');
  const source = await w.offer();
  const name = await w.template('{员工姓名} {发起日期} {企业名称}');
  const code = await w.template('{工号}', 'ZZ_F505_工号模板');
  const text = await w.template('ZZ_F505_纯文本', 'ZZ_F505_静态模板');
  const noName = w.access({ fields: { [EMPLOYEE]: ['code'] } });
  const noCode = w.access({ fields: { [EMPLOYEE]: ['name'] } });
  const noScope = w.access({ scopes: { [EMPLOYEE]: EMPTY_SCOPE } });
  for (const [selected, call] of [
    [name, noName],
    [code, noCode],
    [name, noScope],
  ] as const)
    await reason(await w.post(source, [selected.id], undefined, 1, call), 'FIELD_FORBIDDEN', 403);
  const context = await noScope('GET', contextPath(source));
  expect(context.status).toBe(200);
  expect(await context.text()).not.toContain('ZZ_F505_EMP_S4_VARIABLES');
  await json(await w.post(await w.offer(), [text.id], undefined, 1, noScope), 201);
  const receipt = await json<Receipt>(await w.post(source, [name.id, code.id]), 201);
  await w.patchTemplate(name.id, { body: 'ZZ_F505_后改正文' });
  const files = await w.inTenant((tx) =>
    tx.select().from(esignTaskFiles).where(eq(esignTaskFiles.taskId, receipt.taskId)),
  );
  const person = await w.session.getEmployee(w.employeeId);
  expect(files.find((file) => file.templateId === name.id)?.content).toBe(
    `${person.name} 2026-10-10 ${w.session.tenant.name}`,
  );
  expect(files.find((file) => file.templateId === code.id)?.content).toBe(person.code);
  expect((await w.taskRow(receipt.taskId)).variableReadFields.sort()).toEqual(['code', 'name']);
});

it('AC-12 同源两新键只产生一个在途任务，同键重放在完成后仍返回旧任务', async () => {
  const w = await offerSigningWorld(db().db, 'S4_COMMAND');
  const source = await w.offer();
  const template = await w.template();
  const keys = [uniqueSuffix(), uniqueSuffix()];
  const call = w.access();
  const responses = await Promise.all(keys.map((key) => w.post(source, [template.id], key, 1, call)));
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const winner = responses.findIndex((r) => r.status === 201);
  const receipt = await json<Receipt>(responses[winner]!, 201);
  const key = keys[winner]!;
  expect(await json(await w.post(source, [template.id], key), 201)).toEqual(receipt);
  await reason(await w.post(source, [template.id], key, 2), 'IDEMPOTENCY_CONFLICT', 409);
  await w.inTenant((tx) => tx.update(offers).set({ revision: 2 }).where(eq(offers.id, source)));
  await reason(await w.post(source, [template.id]), 'REVISION_CONFLICT', 409);
  const employeeUser = await w.inTenant((tx) => userOfPerson(tx, w.tenantId, w.employeeId));
  const task = await w.taskRow(receipt.taskId);
  expect((await w.sign(employeeUser!, task)).status).toBe(200);
  expect((await w.sign(w.userId, await w.taskRow(task.id))).status).toBe(200);
  expect(await json(await w.post(source, [template.id], key), 201)).toEqual(receipt);
  expect(await json(await call('GET', resultPath(key)))).toEqual(receipt);
  expect(await w.inTenant((tx) => tx.select().from(esignTasks))).toHaveLength(1);
  const reissued = await json<Receipt>(await w.post(source, [template.id], undefined, 2), 201);
  w.setNow(new Date(START.getTime() + 3 * DAY));
  const next = await json<Receipt>(
    await w.call('POST', taskPath(source), { body: { templateIds: [template.id] }, ifMatch: 2 }),
    201,
  );
  expect(next.taskId).not.toBe(reissued.taskId);
  const expired = await w.taskRow(reissued.taskId);
  expect(expired.status).toBe('expired');
  expect((await w.sign(employeeUser!, expired)).status).toBe(409);
  await reason(
    await call('POST', taskPath(source), { body: { templateIds: [template.id] } }),
    'REVISION_REQUIRED',
    400,
  );
});
