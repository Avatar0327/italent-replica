import { randomUUID } from 'node:crypto';
import { eq, onboardingEntryCases, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { startEmploymentActivationScheduler } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { addPending, entryAction, entryWorld } from './AC-EN-BE2a-support.js';
import { syncWorld } from './AC-OF-BE14b2-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const useDb = useTestDb();
const clock = () => new Date('2026-10-01T12:00:00Z');
const base = '/api/tenant/onboarding';
const employment = '/api/tenant/employment';
const collection = 'TenantBase.OnboardingCollection';

async function json(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

async function poll(db: ReturnType<typeof useDb>['db']) {
  const errors: unknown[] = [];
  await startEmploymentActivationScheduler(db, { clock, onError: (error) => errors.push(error) }).stop();
  expect(errors).toEqual([]);
}

async function world(label: string) {
  const { db } = useDb();
  const w = await entryWorld(db, label);
  const tenant = w.session.tenant.id;
  const user = w.session.user.id;
  const rights = { scope: true, comment: true, status: true, button: true };
  const authorize: Authorizer = (req) => {
    if (req.action === 'data.scope.all') return false;
    if (req.action === 'object.button') return rights.button;
    if (req.resource === collection && req.fields?.includes('comment')) return rights.comment;
    return true;
  };
  registerScopeProvider(authorize, {
    authorize: async (req) => authorize(req),
    scope: async () => ({ all: rights.scope, hasDataPermission: rights.scope, orgIds: [], personIds: [] }),
    fields: async (_tenantId, _userId, objectCode) => {
      if (objectCode === collection)
        return new Set(['id', 'revision', 'status', ...(rights.comment ? ['comment'] : [])]);
      if (objectCode === 'TenantBase.EmploymentRecord' && !rights.status)
        return new Set(['departmentId', 'employType']);
      return new Set([
        'id',
        'revision',
        'status',
        'name',
        'collectionStatus',
        'collectionSettings',
        'collectionRules',
        'collectionTemplates',
      ]);
    },
  });
  const api = tenantApi(db, { authorize, clock });
  const request = (method: string, path: string, options?: RequestOptions) =>
    api.request(method, path, { ...options, tenant, user });
  const manage = (method: string, path: string, options?: RequestOptions) => request(method, base + path, options);
  const make = async (name = label) => {
    const entry = await addPending(w, '2026-10-08', name);
    const [stage] = await withTenant(db, tenant, (tx) =>
      tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.currentBusinessId, entry.recordId)),
    );
    const ref = {
      businessId: entry.recordId,
      businessRevision: entry.business.revision,
      caseRevision: stage!.revision,
    };
    return { ...entry, ref, url: `/entries/${entry.recordId}/collection` };
  };
  return { ...w, tenant, user, rights, request, manage, make };
}

async function configure(
  manage: (method: string, path: string, options?: RequestOptions) => Promise<Response>,
  orgId: string,
) {
  const template = await json(
    await manage('POST', '/collection-templates', {
      ifMatch: 0,
      body: {
        name: 'ZZ_BE16_TEMPLATE',
        enabled: true,
        noticeTitle: 'ZZ_BE16_SAMPLE',
        noticeBody: '请填写入职前采集信息，专属链接只可本人使用、不可转发',
        fields: [{ objectCode: 'TenantBase.EmployeeInformation', fieldCode: 'name', required: true, editable: true }],
      },
    }),
    201,
  );
  await json(
    await manage('POST', '/collection-rules', {
      ifMatch: 0,
      body: { name: 'ZZ_BE16_RULE', enabled: true, priority: 10, templateId: template.id, orgIds: [orgId] },
    }),
    201,
  );
}

it('AC-EN-BE16-03 手动发起仅就绪，协作重放幂等，字段撤权后重放与回查不披露内容', async () => {
  const w = await world('ZZ_BE16_MANUAL');
  await configure(w.manage, w.org.id);
  const entry = await w.make();
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body: entry.ref };
  const started = await json(await w.manage('POST', entry.url + '/start', options), 201);
  expect(started).toMatchObject({ status: 'ready', notificationStatus: 'unavailable' });
  expect(await json(await w.manage('POST', entry.url + '/start', options), 201)).toEqual(started);

  const detail = await json(await w.manage('GET', entry.url));
  expect(detail).toMatchObject({ task: { id: started.id, status: 'ready' } });
  expect(JSON.stringify(detail)).toContain('只可本人使用、不可转发');
  expect(JSON.stringify(detail)).not.toContain('@example.com');
  const remind = await w.manage('POST', entry.url + '/remind', { ifMatch: started.revision, body: entry.ref });
  expect(remind.status).toBe(409);
  expect(await remind.json()).toMatchObject({ error: { details: { reason: 'COLLECTION_CHANNEL_UNAVAILABLE' } } });

  const comment = {
    ifMatch: started.revision,
    idempotencyKey: randomUUID(),
    body: { ...entry.ref, text: 'ZZ_BE16_PRIVATE_COMMENT' },
  };
  const append = () => w.manage('POST', entry.url + '/comments', comment);
  const appended = await json(await append(), 201);
  expect(await json(await append(), 201)).toEqual(appended);
  expect((await json(await w.manage('GET', entry.url))).comments).toHaveLength(1);
  w.rights.comment = false;
  expect((await append()).status).toBe(403);
  expect(JSON.stringify(await json(await w.manage('GET', entry.url)))).not.toContain(comment.body.text);
  const f120 = await json(await w.request('GET', `/api/tenant/commands/${comment.idempotencyKey}/result`));
  expect(f120).toMatchObject({ businessId: null, revision: null });
  expect(JSON.stringify(f120)).not.toContain(comment.body.text);
  w.rights.scope = false;
  expect((await w.manage('POST', entry.url + '/start', options)).status).toBe(404);
});

it('AC-EN-BE16-02/04 自动开关实际控制生产消费，两轮去重，取消及已办理目标无法发起', async () => {
  const w = await world('ZZ_BE16_AUTO');
  await configure(w.manage, w.org.id);
  const ready = await w.make();
  const cancelled = await w.make('ZZ_BE16_CANCELLED');
  const hired = await addPending(w, '2026-09-29', 'ZZ_BE16_HIRED');
  expect((await entryAction(w, cancelled.recordId, 'cancel', {})).status).toBe(200);
  expect((await entryAction(w, hired.recordId, 'complete', { probation: false })).status).toBe(200);

  await poll(w.db);
  const first = (await json(await w.manage('GET', ready.url))).task;
  expect(first).toMatchObject({ status: 'ready' });
  await poll(w.db);
  expect((await json(await w.manage('GET', ready.url))).task).toEqual(first);
  expect((await json(await w.manage('GET', cancelled.url))).task).toBeNull();
  for (const entry of [cancelled, hired]) {
    const url = `/entries/${entry.recordId}/collection/start`;
    expect((await w.manage('POST', url, { ifMatch: 0, body: ready.ref })).status).toBe(409);
  }

  await json(await w.manage('PUT', '/collection-settings', { ifMatch: 0, body: { enabled: false } }));
  const disabled = await w.make('ZZ_BE16_DISABLED');
  await poll(w.db);
  expect((await json(await w.manage('GET', disabled.url))).task).toBeNull();
  await json(await w.manage('PUT', '/collection-settings', { ifMatch: 1, body: { enabled: true } }));
  await poll(w.db);
  expect((await json(await w.manage('GET', disabled.url))).task).toBeNull();
  const list = await json(await w.request('GET', employment + '/pending-entries?view=all&collectionStatus=not_sent'));
  expect(list.items.map((item: { id: string }) => item.id)).toEqual([ready.recordId]);
  w.rights.status = false;
  const visible = await json(await w.request('GET', employment + '/pending-entries?view=all'));
  expect(visible.items.find((item: { id: string }) => item.id === ready.recordId)).not.toHaveProperty(
    'collectionStatus',
  );
  expect((await w.request('GET', employment + '/pending-entries?view=all&collectionStatus=not_sent')).status).toBe(403);
  for (const path of ['/access/challenge', '/access/exchange', '/collection/submit', '/collection/withdraw'])
    expect((await w.request('POST', '/api/onboarding' + path, { body: {} })).status).toBe(404);
});

it('AC-EN-BE16-03 批量父键锁定目标顺序，撤权后无逐条披露', async () => {
  const w = await world('ZZ_BE16_BATCH');
  await configure(w.manage, w.org.id);
  const entry = await w.make();
  const absent = randomUUID();
  const targets = [
    { ...entry.ref, id: entry.recordId, revision: 0 },
    { ...entry.ref, id: absent, businessId: absent, revision: 0 },
  ];
  const opts = { ifMatch: 0, idempotencyKey: randomUUID(), body: { targets } };
  const start = (options: RequestOptions) => w.manage('POST', '/collection/start-batch', options);
  const first = await json(await start(opts));
  expect(first).toEqual({ items: [expect.objectContaining({ id: entry.recordId, status: 'ready' })] });
  expect(await json(await start(opts))).toEqual(first);
  expect((await start({ ...opts, body: { targets: targets.toReversed() } })).status).toBe(409);
  w.rights.scope = false;
  expect(await json(await start(opts))).toEqual({ items: [] });
});

it('AC-OF-10 Offer 同步的采集投影由实际就绪任务产生，重复生产轮询不重复发起', async () => {
  const { db } = useDb();
  const w = await syncWorld(db, 'ZZ_BE16_OFFER_COLLECTION');
  const api = tenantApi(db, { clock });
  const actor = { tenant: w.tenant.id, user: w.user.id };
  await configure((method, path, opts) => api.request(method, base + path, { ...opts, ...actor }), w.department.id);
  const offer = await w.accepted(await w.social({ name: 'ZZ_BE16_OFFER_COLLECTION' }));
  const entry = await w.entryOf(offer);
  const list = async () => {
    const r = await json(await api.request('GET', employment + '/pending-entries?view=all', actor));
    return r.items.find((item: { id: string }) => item.id === entry.id);
  };
  expect(await list()).toMatchObject({ collectionStatus: 'not_started' });
  await poll(db);
  expect(await list()).toMatchObject({ collectionStatus: 'not_sent' });
  await poll(db);
  expect(await list()).toMatchObject({ collectionStatus: 'not_sent' });
});
