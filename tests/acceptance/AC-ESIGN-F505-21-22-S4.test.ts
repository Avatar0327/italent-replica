import { randomUUID } from 'node:crypto';
import { commandLedger, eq, esignOfferSources, esignTasks, offers, tenantMemberships, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { ESIGN, NOTICE, START } from './AC-ESIGN-F505-s2-support.js';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import { handledSingle } from './AC-F476-p6-support.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import {
  contextPath,
  EMPLOYEE,
  offerSigningWorld,
  OFFERS,
  OFFER_OBJECT,
  RECORD,
  recordsPath,
  type Receipt,
  resultPath,
  taskPath,
} from './AC-ESIGN-F505-S4-support.js';

const db = useTestDb();

it('AC-21 撤销编辑权、来源范围、变量字段或人员范围，原键重放与只读回查均拒绝', async () => {
  const w = await offerSigningWorld(db().db, 'S4_REPLAY');
  const source = await w.offer();
  const template = await w.template('{员工姓名}');
  const key = uniqueSuffix();
  const receipt = await json<Receipt>(await w.post(source, [template.id], key), 201);
  expect(await json(await w.access()('GET', resultPath(key)))).toEqual(receipt);
  await w.patchTemplate(template.id, { body: 'ZZ_F505_已改为静态正文' });
  for (const [call, code, status] of [
    [w.access({ deny: (q) => q.action === 'object.update' && q.resource === OFFER_OBJECT }), 'FORBIDDEN', 403],
    [w.access({ scopes: { [OFFER_OBJECT]: EMPTY_SCOPE } }), 'NOT_FOUND', 404],
    [w.access({ fields: { [EMPLOYEE]: ['code'] } }), 'FIELD_FORBIDDEN', 403],
    [w.access({ scopes: { [EMPLOYEE]: EMPTY_SCOPE } }), 'FIELD_FORBIDDEN', 403],
  ] as const) {
    for (const r of [await w.post(source, [template.id], key, 1, call), await call('GET', resultPath(key))]) {
      const copy = r.clone();
      await reason(r, code, status);
      expect(await copy.text()).not.toMatch(/sourceId|taskId|httpStatus|succeeded/);
    }
  }
  const differentOffer = await w.offer();
  await w.inTenant((tx) =>
    tx
      .update(commandLedger)
      .set({ responseBody: { ...receipt, sourceId: differentOffer } })
      .where(eq(commandLedger.commandId, key)),
  );
  await reason(await w.access()('GET', resultPath(key)), 'NOT_FOUND', 404);
});

it('AC-21/22 来源与人员双范围先于分页，字段裁剪与下载错误均隐藏文件信息', async () => {
  const w = await offerSigningWorld(db().db, 'S4_RECORDS');
  const source = await w.offer();
  const template = await w.template('ZZ_F505_正文', 'ZZ_F505_文件机密名称');
  const visible = await w.hire('ZZ_F505_可见');
  const invisible = await w.hire('ZZ_F505_范围外');
  const unrelated = await w.hire('ZZ_F505_另一来源');
  const older = await w.fixture('offer', template, false, visible);
  const newer = await w.fixture('offer', template, false, invisible);
  const other = await w.fixture('offer', template, false, unrelated);
  await w.inTenant(async (tx) => {
    await tx.insert(esignOfferSources).values({ tenantId: w.tenantId, offerId: source });
    await tx
      .update(esignTasks)
      .set({ offerId: source, status: 'revoked', currentNode: null, revokedAt: new Date(), revokeCause: 'manual' })
      .where(eq(esignTasks.id, older.id));
    await tx.update(esignTasks).set({ offerId: source, initiatedAt: new Date() }).where(eq(esignTasks.id, newer.id));
  });
  const call = w.access({
    scopes: {
      [RECORD]: { ...EMPTY_SCOPE, personIds: [visible.employeeId, unrelated.employeeId], hasDataPermission: true },
    },
    fields: { [RECORD]: ['scene'] },
  });
  const path = `${recordsPath(source)}?page=1&pageSize=1`;
  expect(await json(await call('GET', path))).toEqual({
    items: [{ id: older.id, revision: older.revision, scene: 'offer' }],
    total: 1,
    page: 1,
    pageSize: 1,
  });
  expect(await json(await w.access()('GET', recordsPath(source)))).toMatchObject({
    items: [{ id: newer.id }, { id: older.id }],
    total: 2,
  });
  expect(other.offerId).not.toBe(source);
  await reason(await call('GET', `${recordsPath(source)}?pageSize=101`), 'VALIDATION_FAILED', 400);
  const forbidden = w.access({ deny: (q) => q.resource === RECORD && q.action === 'object.view' });
  const response = await forbidden('GET', recordsPath(source));
  await reason(response.clone(), 'FORBIDDEN', 403);
  expect(await response.text()).not.toMatch(/items|total|机密名称/);
  const files = await call('GET', `${ESIGN}/records/files?ids=${older.id}`);
  await reason(files.clone(), 'FIELD_FORBIDDEN', 403);
  expect(await files.text()).not.toContain(template.name);
});

it('AC-21 已办审批份不能打开现值签署上下文、发起或读取来源历史', async () => {
  const w = await offerApprovalWorld(db().db, 'ZZ_F505_S4_FROZEN');
  const { offer } = await handledSingle(w);
  const path = `${OFFERS}/${offer.id}`;
  const approver = w.head.userId;
  const current = await w.get(offer.id);
  await json(await w.request(w.applicant.userId, 'GET', contextPath(offer.id)));
  const prior = await json<{ contentView: { mode: string } }>(await w.request(approver, 'GET', path));
  expect(prior.contentView.mode).toBe('frozen');
  for (const read of [contextPath(offer.id), recordsPath(offer.id)])
    await reason(await w.request(approver, 'GET', read), 'NOT_FOUND', 404);
  await reason(
    await w.request(approver, 'POST', taskPath(offer.id), {
      ifMatch: current.revision,
      body: { templateIds: [randomUUID()] },
    }),
    'NOT_FOUND',
    404,
  );
});

it.each(['从未有姓名读权', '人员范围外', '通知写入后撤姓名读权'] as const)(
  'AC-07/10/21 真实 Offer 编辑撤销的通知只含场景与任务号（%s）',
  async (mode) => {
    const w = await offerSigningWorld(db().db, 'S4_NOTICE');
    const source = await w.offer();
    const template = await w.template();
    const canReadName = mode === '通知写入后撤姓名读权';
    const restricted = w.access({
      deny: (q) => q.action.startsWith('object.') && q.resource !== OFFER_OBJECT && q.resource !== EMPLOYEE,
      scopes: { ...(mode === '人员范围外' ? { [EMPLOYEE]: EMPTY_SCOPE } : {}) },
      fields: { ...(canReadName ? {} : { [EMPLOYEE]: ['code'] }) },
    });
    const receipt = await json<Receipt>(await w.post(source, [template.id], undefined, 1, restricted), 201);
    const edit = await restricted('PUT', `${OFFERS}/${source}`, {
      ifMatch: 1,
      body: { workPlace: 'ZZ_F505_变更地点' },
    });
    await json(edit);
    expect(await w.taskRow(receipt.taskId)).toMatchObject({ status: 'revoked', revokeCause: 'source_changed' });
    const read = w.access({ fields: { [EMPLOYEE]: ['code'] }, scopes: { [EMPLOYEE]: EMPTY_SCOPE } });
    const response = await read('GET', NOTICE);
    expect(response.status).toBe(200);
    const list = await response.text();
    expect(list).toContain(receipt.taskId);
    expect(list).toContain('已撤销');
    expect(list).not.toContain('ZZ_F505_EMP_S4_NOTICE');
    expect(list).not.toContain(template.name);
    const notices = await w.notices();
    expect(notices).toHaveLength(2);
    for (const notice of notices) expect(notice.payload).toEqual({ scene: 'offer', taskNumber: receipt.taskId });
    const nonRecipient = await w.member();
    expect(await (await read('GET', NOTICE)).text()).not.toContain('"payload"');
    expect(await (await w.access({}, nonRecipient.user.id)('GET', NOTICE)).text()).not.toContain(receipt.taskId);
    expect(
      await (await w.call('GET', NOTICE, { user: nonRecipient.user.id, tenant: nonRecipient.tenant.id })).text(),
    ).not.toContain(receipt.taskId);
    await w.inTenant((tx) =>
      tx.update(tenantMemberships).set({ status: 'revoked' }).where(eq(tenantMemberships.userId, w.userId)),
    );
    expect((await read('GET', NOTICE)).status).toBe(403);
  },
);

it('AC-22 不存在、跨租户和超出 Offer 范围的错误信封一致', async () => {
  const w = await offerSigningWorld(db().db, 'S4_ENVELOPE');
  const source = await w.offer();
  const template = await w.template();
  const foreign = await seedTenantWithMember(db().db, 'ZZ_F505_FOREIGN');
  const foreignId = randomUUID();
  await withTenant(db().db, foreign.tenant.id, (tx) =>
    tx.insert(offers).values({
      id: foreignId,
      tenantId: foreign.tenant.id,
      name: 'ZZ_F505_其他租户',
      entry: 'offer',
      personalEmail: 'f505-foreign@example.com',
      createdBy: foreign.user.id,
      status: 'accepted',
      acceptTime: START,
    }),
  );
  await json(await w.access()('GET', contextPath(source)));
  const outOfScope = w.access({ scopes: { [OFFER_OBJECT]: EMPTY_SCOPE } });
  for (const request of [
    (id: string, call: ReturnType<typeof w.access>) => call('GET', contextPath(id)),
    (id: string, call: ReturnType<typeof w.access>) => w.post(id, [template.id], undefined, 1, call),
    (id: string, call: ReturnType<typeof w.access>) => call('GET', recordsPath(id)),
  ]) {
    const missing = await json(await request(randomUUID(), w.access()), 404);
    expect(missing).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await json(await request(foreignId, w.access()), 404)).toEqual(missing);
    expect(await json(await request(source, outOfScope), 404)).toEqual(missing);
  }
});
