import { randomUUID } from 'node:crypto';
import { and, eq, esignTaskFiles, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { businessRevision, entryAction } from './AC-EN-BE2a-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { EMPLOYEE_OBJECT, ESIGN, resultPath, s5World, source, type Receipt } from './AC-ESIGN-F505-s5-support.js';

const database = useTestDb();
let w: Awaited<ReturnType<typeof s5World>>;
let plain: Awaited<ReturnType<(typeof w)['template']>>;

beforeAll(async () => {
  w = await s5World(database().db);
  plain = await w.template();
});

it.each(['rehire', 'retire_rehire'] as const)('AC-05 未来待入职 %s 取本记录状态', async (kind) => {
  const entry = await w.pending(kind);
  expect(entry.kind).toBe(kind);
  expect(await json(await w.call('GET', source(entry.id, 'context')))).toMatchObject({ canInitiate: true });
  const receipt = await json<Receipt>(await w.submit(entry, [plain.id]), 201);
  expect(await w.tasks(entry)).toMatchObject([{ id: receipt.taskId, sourceRevision: entry.revision }]);
});

it('AC-05 取消及已办理保留来源，拒绝新发起', async () => {
  const cancelled = await w.pending();
  const hired = await w.pending();
  const key = uniqueSuffix();
  const receipt = await json<Receipt>(await w.submit(hired, [plain.id], key), 201);
  for (const [entry, action, body, reason] of [
    [cancelled, 'cancel', {}, 'ENTRY_CANCELLED'],
    [hired, 'complete', { probation: false }, 'NOT_PENDING_ENTRY'],
  ] as const) {
    await json(await entryAction(w, entry.id, action, body, entry.revision));
    const revision = await businessRevision(w, entry.id);
    expect(await json(await w.call('GET', source(entry.id, 'context')))).toMatchObject({
      canInitiate: false,
      reason,
      revision,
    });
    expect(await w.error(await w.submit({ ...entry, revision }, [plain.id]), 409)).toMatchObject({
      error: { details: { reason } },
    });
  }
  const readOnly = w.restricted({ deny: ({ action }) => action === 'object.update' || action === 'object.button' });
  expect(await json(await readOnly('GET', source(hired.id, 'records')))).toMatchObject({
    items: [{ id: receipt.taskId, status: 'signing' }],
  });
  expect(await json(await w.submit(hired, [plain.id], key), 201)).toEqual(receipt);
  expect(await json(await w.call('GET', resultPath(key)))).toEqual(receipt);
});

it.each(['删除', '改期'])('AC-05/21 %s 后原来源三路由及命令回查全部 404', async (action) => {
  const entry = await w.pending();
  const key = uniqueSuffix();
  await json(await w.submit(entry, [plain.id], key), 201);
  const response =
    action === '删除'
      ? await w.session.request('DELETE', `/pending-entries/${entry.id}`, { ifMatch: entry.revision })
      : await entryAction(w, entry.id, 'postpone', { effectiveDate: '2026-12-20' }, entry.revision);
  const saved = await json<{ id: string }>(response);
  const denied = await w.error(await w.call('GET', source(entry.id, 'context')), 404, 'NOT_FOUND');
  expect(await w.error(await w.call('GET', source(entry.id, 'records')), 404)).toEqual(denied);
  expect(await w.error(await w.submit(entry, [plain.id], key), 404)).toEqual(denied);
  await w.error(await w.call('GET', resultPath(key)), 404);
  if (action === '改期') {
    expect(saved.id).not.toBe(entry.id);
    expect(await json(await w.call('GET', source(saved.id, 'records')))).toMatchObject({ items: [], total: 0 });
  }
});

it('AC-06 停用与外租户模板隐藏，选项失效、含调动变量或 21 个拒绝且无任务', async () => {
  const entry = await w.pending();
  const disabled = await w.template('ZZ_F505_停用之前正文', 'ZZ_F505_停用');
  const changed = await w.template('ZZ_F505_变更之前正文', 'ZZ_F505_变更');
  const foreign = await seedTenantWithMember(w.db, 'ZZ_F505_外租户');
  const external = await json<{ id: string }>(
    await w.call('POST', `${ESIGN}/templates`, {
      tenant: foreign.tenant.id,
      user: foreign.user.id,
      body: { code: uniqueSuffix(), name: 'ZZ_F505_外租户模板', body: 'ZZ_F505_外租户正文' },
    }),
    201,
  );
  const update = (t: typeof plain, body: object) =>
    w.call('PATCH', `${ESIGN}/templates/${t.id}`, { ifMatch: t.revision, body });
  const selected = await json<{ items: { id: string }[] }>(await w.call('GET', source(entry.id, 'context')));
  expect(selected.items.map(({ id }) => id)).toEqual(expect.arrayContaining([disabled.id, changed.id]));
  expect(selected.items.map(({ id }) => id)).not.toContain(external.id);
  await json(await update(disabled, { status: 'disabled' }));
  await json(await update(changed, { body: '{调入部门}' }));
  const current = JSON.stringify(await json(await w.call('GET', source(entry.id, 'context'))));
  for (const id of [disabled.id, changed.id, external.id]) expect(current).not.toContain(id);
  for (const [ids, reason] of [
    [[plain.id, disabled.id], 'ESIGN_TEMPLATE_UNAVAILABLE'],
    [[external.id], 'ESIGN_TEMPLATE_UNAVAILABLE'],
    [[changed.id], 'ESIGN_TEMPLATE_INCOMPATIBLE'],
  ] as const) {
    expect(await w.error(await w.submit(entry, [...ids]), 400)).toMatchObject({ error: { details: { reason } } });
  }
  await w.error(
    await w.submit(
      entry,
      Array.from({ length: 21 }, () => randomUUID()),
    ),
    400,
    'VALIDATION_FAILED',
  );
  expect(await w.tasks(entry)).toEqual([]);
});

it('AC-07/12 有权时正文冻结；两节点完成后旧命令仍返回原任务', async () => {
  const entry = await w.pending();
  const body = '{员工姓名}|{工号}|{发起日期}|{企业名称}';
  const template = await w.template(body, 'ZZ_F505_冻结模板');
  await w.error(await w.submit(entry, [template.id], uniqueSuffix(), { fields: { [EMPLOYEE_OBJECT]: ['name'] } }), 403);
  const key = uniqueSuffix();
  const receipt = await json<Receipt>(await w.submit(entry, [template.id], key), 201);
  await json(
    await w.call('PATCH', `${ESIGN}/templates/${template.id}`, {
      ifMatch: template.revision,
      body: { body: 'ZZ_F505_新版模板正文' },
    }),
  );
  const files = await withTenant(w.db, w.as.tenant, (tx) =>
    tx
      .select({ body: esignTaskFiles.content })
      .from(esignTaskFiles)
      .where(and(eq(esignTaskFiles.tenantId, w.as.tenant), eq(esignTaskFiles.taskId, receipt.taskId))),
  );
  expect(files).toEqual([
    { body: `${entry.employee.name}|${entry.employee.code}|2026-10-10|${w.session.tenant.name}` },
  ]);
  const sign = (user: string, revision: number) =>
    w.call('POST', `${ESIGN}/mine/${receipt.taskId}/sign`, { user, body: { revision } });
  expect(entry.employeeUser).toBeTruthy();
  const next = await json<{ revision: number }>(await sign(entry.employeeUser!, 1));
  expect(await json(await sign(w.as.user, next.revision))).toMatchObject({ status: 'completed' });
  expect(await json(await w.submit(entry, [template.id], key), 201)).toEqual(receipt);
  expect(await json(await w.call('GET', resultPath(key)))).toEqual(receipt);
  expect(await w.tasks(entry)).toHaveLength(1);
  expect(await businessRevision(w, entry.id)).toBe(entry.revision);

  const newTask = await json<Receipt>(await w.submit(entry, [plain.id]), 201);
  expect(newTask.taskId).not.toBe(receipt.taskId);
  const taskIds = [receipt.taskId, newTask.taskId].sort().reverse();
  for (const [index, taskId] of taskIds.entries()) {
    const page = index + 1;
    expect(await json(await w.call('GET', `${source(entry.id, 'records')}?pageSize=1&page=${page}`))).toMatchObject({
      items: [{ id: taskId }],
      total: 2,
      page,
      pageSize: 1,
    });
  }
  await w.error(await w.call('GET', `${source(entry.id, 'records')}?pageSize=101`), 400);
});
