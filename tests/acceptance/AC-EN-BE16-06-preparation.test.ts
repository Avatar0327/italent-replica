import { bootstrapTenantAdmin } from '@italent/api';
import { randomUUID } from 'node:crypto';
import {
  and,
  auditEvents,
  commandLedger,
  eq,
  grantMembership,
  onboardingEntryCases,
  onboardingPreparationTasks,
  permissionGrants,
  permissionProfiles,
  permissionUserPersonLinks,
  sql,
  tenantMemberships,
  withTenant,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { createTestDb, useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/read-model.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { addHire, addPending, entryAction, entryWorld, hireBody, portContext } from './AC-EN-BE2a-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

import { launchEntryPreparations } from '../../apps/api/src/modules/onboarding/preparation-launch.js';
import {
  listDuePreparations,
  listMyPreparations,
} from '../../apps/api/src/modules/onboarding/preparation-launch-read.js';
import { newUser } from './support/platform-api.js';

const testDb = useTestDb();
const now = new Date('2026-10-01T12:00:00Z');
const items = '/preparation-items';
const rules = '/preparation-rules';
const item = {
  category: 'other',
  code: 'ZZ_BE16_PREPARATION',
  name: 'ZZ_BE16_PREPARATION',
  fields: [{ code: 'remark', label: '办理说明', required: true }],
};
type Receipt = { id: string; revision: number; status: string };

async function world(label: string) {
  const { db } = testDb();
  const w = await entryWorld(db, label);
  const tenant = w.session.tenant.id;
  const user = w.session.user.id;
  const rights = { admin: true, fields: new Set(['preparationItems', 'preparationRules']), orgs: [w.org.id] };
  const settings = MODULE_OBJECTS.employmentSettings.code;
  const authorize: Authorizer = (req) => {
    if (req.action === 'admin.other_settings' || req.action === 'tenant.employment.configuration.write')
      return rights.admin;
    return req.resource === settings && (req.fields ?? []).every((field) => rights.fields.has(field));
  };
  registerScopeProvider(authorize, {
    authorize: async (req) => authorize(req),
    scope: async () => ({ all: false, hasDataPermission: true, orgIds: rights.orgs, personIds: [] }),
    fields: async () => rights.fields,
  });
  const api = tenantApi(db, { authorize, clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, '/api/tenant/onboarding' + path, { tenant, user, ...options });
  const create = (path: string, body: object) => request('POST', path, { ifMatch: 0, body });
  const ledger = (id: string) =>
    withTenant(db, tenant, (tx) =>
      tx
        .select()
        .from(commandLedger)
        .where(and(eq(commandLedger.tenantId, tenant), eq(commandLedger.commandId, id))),
    );
  return { ...w, tenant, user, request, create, rights, ledger };
}

async function response<T>(res: Response, status: number) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

it('AC-EN-BE16-06 A40 目录不收办理人，使用配置字段权和版本保护目录', async () => {
  const w = await world('ZZ_BE16_PREP_ITEMS');
  expect((await w.create(items, { ...item, assignees: [{ kind: 'member', id: w.user }] })).status).toBe(400);
  const row = await response<Receipt>(await w.create(items, item), 201);
  const path = items + '/' + row.id;
  expect(await response(await w.request('GET', path), 200)).toMatchObject(item);
  expect((await w.create(items, item)).status).toBe(409);
  const key = randomUUID();
  const edit = () =>
    w.request('PATCH', path, { ifMatch: row.revision, idempotencyKey: key, body: { name: 'ZZ_BE16_V2' } });
  const saved = await response<Receipt>(await edit(), 200);
  expect(await response(await edit(), 200)).toEqual(saved);
  w.rights.fields.delete('preparationItems');
  expect((await edit()).status).toBe(403);
  w.rights.fields.add('preparationItems');
  w.rights.admin = false;
  expect((await w.request('GET', path)).status).toBe(403);
  expect((await edit()).status).toBe(403);
  w.rights.admin = true;
  expect((await w.request('DELETE', path, { ifMatch: row.revision })).status).toBe(409);
  expect((await w.request('DELETE', path, { ifMatch: saved.revision })).status).toBe(204);
  expect((await w.request('GET', path)).status).toBe(404);
});

it('AC-EN-BE16-06 A41 独立保存发起催办参数和办理人，范围先于分页且拒绝越权重放', async () => {
  const w = await world('ZZ_BE16_PREP_RULES');
  const outside = await w.session.org('ZZ_BE16_OUTSIDE', { establishedOn: '2026-01-01' });
  const row = await response<Receipt>(await w.create(items, item), 201);
  const body = {
    itemId: row.id,
    name: 'ZZ_BE16_RULE',
    priority: 10,
    orgIds: [w.org.id],
    startDaysBefore: 3,
    remindDaysBefore: 2,
    assignees: [{ kind: 'member', id: w.user }, { kind: 'department_head' }],
  };
  expect((await w.create(rules, { ...body, orgIds: [outside.id] })).status).toBe(404);
  expect((await w.create(rules, { ...body, assignees: [{ kind: 'member', id: randomUUID() }] })).status).toBe(404);
  w.rights.orgs.push(outside.id);
  const hidden = await response<Receipt>(await w.create(rules, { ...body, orgIds: [outside.id] }), 201);
  const key = randomUUID();
  const save = () => w.request('POST', rules, { ifMatch: 0, idempotencyKey: key, body });
  const shown = await response<Receipt>(await save(), 201);
  w.rights.orgs = [w.org.id];
  expect(await response(await w.request('GET', rules + '?pageSize=1'), 200)).toMatchObject({
    items: [{ id: shown.id }],
  });
  expect((await w.request('GET', rules + '/' + hidden.id)).status).toBe(404);
  expect(await response(await w.request('GET', rules + '/' + shown.id), 200)).toMatchObject(body);
  w.rights.orgs = [];
  expect((await save()).status).toBe(404);
  expect(await w.ledger(key)).toHaveLength(1);
  expect((await w.request('GET', '/my/preparations')).status).toBe(404);
  expect((await w.request('POST', '/entries/' + randomUUID() + '/preparations/start')).status).toBe(404);
});

it('AC-EN-BE16-06 DEC-983 真实租户管理员可按编辑权归档目录，回放只返回原回执', async () => {
  const { db } = testDb();
  const { tenant, user } = await seedTenantWithMember(db, 'ZZ_BE16_PREP_ADMIN');
  await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  const actor = { tenant: tenant.id, user: user.id };
  const path = '/api/tenant/onboarding' + items;
  const created = await response<Receipt>(await api.request('POST', path, { ...actor, ifMatch: 0, body: item }), 201);
  const key = randomUUID();
  const archive = (ifMatch: number) =>
    api.request('DELETE', path + '/' + created.id, {
      ...actor,
      ifMatch,
      idempotencyKey: key,
    });
  expect((await archive(0)).status).toBe(409);
  expect((await archive(created.revision)).status).toBe(204);
  expect((await archive(created.revision)).status).toBe(204);
  expect((await api.request('GET', path + '/' + created.id, actor)).status).toBe(404);
  const audits = await withTenant(db, tenant.id, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.commandId, key)),
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: 'onboarding.preparationItems.archive',
    objectId: created.id,
    before: { enabled: true, archived: false },
    after: { enabled: false, archived: true },
  });
});

it('AC-EN-BE16-06 DEC-983 规则归档重放复核组织范围，引用中的事项不能归档', async () => {
  const w = await world('ZZ_BE16_PREP_ARCHIVE');
  const saved = await response<Receipt>(await w.create(items, item), 201);
  const rule = await response<Receipt>(
    await w.create(rules, {
      itemId: saved.id,
      name: 'ZZ_BE16_ARCHIVE',
      priority: 1,
      orgIds: [w.org.id],
      assignees: [{ kind: 'member', id: w.user }],
    }),
    201,
  );
  const target = rules + '/' + rule.id;
  expect((await w.request('DELETE', items + '/' + saved.id, { ifMatch: saved.revision })).status).toBe(409);
  const key = randomUUID();
  const archive = () => w.request('DELETE', target, { ifMatch: rule.revision, idempotencyKey: key });
  w.rights.fields.delete('preparationRules');
  expect((await archive()).status).toBe(403);
  w.rights.fields.add('preparationRules');
  w.rights.orgs = [];
  expect((await archive()).status).toBe(404);
  expect(await w.ledger(key)).toEqual([]);
  w.rights.orgs = [w.org.id];
  expect((await archive()).status).toBe(204);
  w.rights.orgs = [];
  expect((await archive()).status).toBe(404);
  expect(await w.ledger(key)).toHaveLength(1);
});

it('AC-EN-BE16-06 按当前阶段按期发起，等优先级和空办理人逐事项拒绝', async () => {
  const w = await world('ZZ_BE16_PREP_LAUNCH');
  const day = (date: string) => new Date(date + 'T12:00:00Z');
  const entry = await addPending(w, '2026-10-08', 'ZZ_BE16_PREP_LAUNCH');
  const [stage] = await withTenant(w.db, w.tenant, (tx) => tx.select().from(onboardingEntryCases));
  const ref = {
    caseId: stage!.id,
    caseRevision: stage!.revision,
    employeeId: entry.employee.id,
    businessId: entry.recordId,
    businessRevision: entry.business.revision,
  };
  const launch = (date: string, itemIds?: string[]) =>
    withTenant(w.db, w.tenant, (tx) =>
      launchEntryPreparations(tx, { ...portContext(w, 0), now: day(date) }, ref, 'auto', itemIds),
    );
  const catalog = async (code: string) => response<Receipt>(await w.create(items, { ...item, code }), 201);
  const saved = await catalog('ZZ_BE16_DUE');
  const empty = await catalog('ZZ_BE16_EMPTY');
  const tied = await catalog('ZZ_BE16_TIED');
  const recipient = await newUser(w.db, 'ZZ_BE16_RECIPIENT');
  await grantMembership(w.db, { tenantId: w.tenant, userId: recipient.id, expectedRevision: 0 }, cmd());
  const addRule = async (itemId: string, extra: object) =>
    response<Receipt>(
      await w.create(rules, {
        itemId,
        name: 'ZZ_BE16_PRIORITY',
        priority: 10,
        orgIds: [w.org.id],
        assignees: [{ kind: 'member', id: w.user }],
        ...extra,
      }),
      201,
    );
  await addRule(empty.id, { assignees: [{ kind: 'direct_manager' }] });
  await addRule(tied.id, {});
  await addRule(tied.id, {});
  await addRule(saved.id, { priority: 20 });
  const rule = await addRule(saved.id, { startDaysBefore: 3, assignees: [{ kind: 'member', id: recipient.id }] });
  expect(await launch('2026-10-01', [empty.id, tied.id])).toEqual([
    { itemId: empty.id, status: 'failed', code: 'PREPARATION_ASSIGNEE_EMPTY' },
    { itemId: tied.id, status: 'failed', code: 'PREPARATION_RULE_AMBIGUOUS' },
  ]);
  const [scheduled] = await launch('2026-10-01', [saved.id]);
  expect(scheduled).toMatchObject({ itemId: saved.id, status: 'scheduled', revision: 1 });
  await response(
    await w.request('PATCH', items + '/' + saved.id, {
      ifMatch: saved.revision,
      body: { name: 'ZZ_BE16_FORM_EDIT' },
    }),
    200,
  );
  await response(
    await w.request('PATCH', rules + '/' + rule.id, {
      ifMatch: rule.revision,
      body: { assignees: [{ kind: 'member', id: w.user }] },
    }),
    200,
  );
  const pending = (when: string) => withTenant(w.db, w.tenant, (tx) => listDuePreparations(tx, w.tenant, when, 10));
  expect(await pending('2026-10-04')).toEqual([]);
  expect(await pending('2026-10-05')).toMatchObject([{ ...ref, itemId: saved.id }]);
  const [opened] = await launch('2026-10-05', [saved.id]);
  expect(opened).toMatchObject({ status: 'open', revision: 2 });
  expect(await launch('2026-10-05', [saved.id])).toEqual([opened]);
  const mine = (user: string) =>
    withTenant(w.db, w.tenant, (tx) => listMyPreparations(tx, w.tenant, user, { limit: 10, offset: 0 }));
  expect(await mine(w.user)).toEqual([]);
  expect(await mine(recipient.id)).toMatchObject([{ name: 'ZZ_BE16_PREPARATION', fields: item.fields }]);
  const setMembership = (status: 'active' | 'revoked') =>
    withTenant(w.db, w.tenant, (tx) =>
      tx
        .update(tenantMemberships)
        .set({ status })
        .where(and(eq(tenantMemberships.tenantId, w.tenant), eq(tenantMemberships.userId, recipient.id))),
    );
  await setMembership('revoked');
  expect(await mine(recipient.id)).toEqual([]);
  await setMembership('active');
  expect(await mine(recipient.id)).toHaveLength(1);
  const before = await w.session.request('GET', '/pending-entries?view=all');
  expect(await response(before, 200)).toMatchObject({
    items: [{ id: entry.recordId, preparationStatus: 'in_progress' }],
  });
  const allow: Authorizer = () => true;
  registerScopeProvider(allow, {
    authorize: async () => true,
    scope: async () => ({ all: true, hasDataPermission: true, orgIds: [], personIds: [] }),
    fields: async () => new Set(['id']),
  });
  const limited = tenantApi(w.db, { authorize: allow, clock: () => now });
  const visible = await response<{ items: object[] }>(
    await limited.request('GET', '/api/tenant/employment/pending-entries?view=all', { tenant: w.tenant, user: w.user }),
    200,
  );
  expect(visible.items).toEqual([expect.objectContaining({ id: entry.recordId })]);
  expect(visible.items[0]).not.toHaveProperty('preparationStatus');
  const cancel = await entryAction(w, entry.recordId, 'cancel', {});
  expect(cancel.status, await cancel.clone().text()).toBe(200);
  expect(await mine(recipient.id)).toEqual([]);
  const closed = await w.session.request('GET', '/pending-entries?view=cancelled');
  expect(await response(closed, 200)).toMatchObject({ items: [{ id: entry.recordId, preparationStatus: 'closed' }] });
});

it('AC-EN-BE16-06 当前任职岗位、身份和组织角色各自可解算准备办理人', async () => {
  const w = await world('ZZ_BE16_PREP_SELECTORS');
  const api = tenantApi(w.db, { clock: () => now });
  const job = async (kind: string, body: object) =>
    response<{ id: string }>(
      await api.request('POST', '/api/tenant/job/' + kind, {
        tenant: w.tenant,
        user: w.user,
        ifMatch: 0,
        body: { startDate: '2026-01-01', ...body },
      }),
      201,
    );
  const post = await job('posts', { code: 'ZZ_BE16_POST', name: 'ZZ_BE16_POST' });
  const position = await job('positions', {
    code: 'ZZ_BE16_POSITION',
    name: 'ZZ_BE16_POSITION',
    orgId: w.org.id,
    postId: post.id,
  });
  const outside = await w.session.org('ZZ_BE16_JOB_OUTSIDE', { establishedOn: '2026-01-01' });
  const outsidePosition = await job('positions', {
    code: 'ZZ_BE16_JOB_OUTSIDE',
    name: 'ZZ_BE16_JOB_OUTSIDE',
    orgId: outside.id,
    postId: post.id,
  });
  const scopedItem = await response<Receipt>(await w.create(items, { ...item, code: 'ZZ_BE16_SCOPE_REF' }), 201);
  const status = await w.create(rules, {
    itemId: scopedItem.id,
    name: 'ZZ_BE16_OUTSIDE_POSITION',
    priority: 1,
    orgIds: [w.org.id],
    assignees: [{ kind: 'position', id: outsidePosition.id }],
  });
  expect(status.status).toBe(404);
  const manager = await w.session.employee('ZZ_BE16_MANAGER');
  await response(
    await addHire(w.session, manager, {
      ...hireBody(w.org.id, '2026-09-01'),
      fields: { employType: 'internal', departmentId: w.org.id, postId: post.id, positionId: position.id },
    }),
    201,
  );
  const org = await w.session.org('ZZ_BE16_LED_ORG', {
    establishedOn: '2026-09-02',
    personInChargeId: manager.id,
    hrbpId: manager.id,
    parents: { admin: { parentId: w.org.id } },
  });
  w.rights.orgs.push(org.id);
  const [recipient, identity] = await withTenant(w.db, w.tenant, async (tx) => {
    const [link] = await tx
      .select()
      .from(permissionUserPersonLinks)
      .where(eq(permissionUserPersonLinks.employeeId, manager.id));
    const [profile] = await tx
      .insert(permissionProfiles)
      .values({
        tenantId: w.tenant,
        code: 'ZZ_BE16_ASSIGNEE',
        name: 'ZZ_BE16_ASSIGNEE',
      })
      .returning();
    await tx.insert(permissionGrants).values({ tenantId: w.tenant, userId: link!.userId, profileId: profile!.id });
    return [link!.userId, profile!.id] as const;
  });
  const target = await w.session.employee('ZZ_BE16_PREP_TARGET');
  const entry = await response<{ id: string; revision: number }>(
    await addHire(w.session, target, {
      ...hireBody(org.id, '2026-10-10'),
      pendingEntry: true,
      fields: { employType: 'internal', departmentId: org.id, directManagerId: manager.id },
    }),
    201,
  );
  const [stage] = await withTenant(w.db, w.tenant, (tx) =>
    tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.currentBusinessId, entry.id)),
  );
  const variants = [
    { kind: 'position', id: position.id },
    { kind: 'post', id: post.id },
    { kind: 'identity', id: identity },
    { kind: 'direct_manager' },
    { kind: 'department_head' },
    { kind: 'hrbp' },
  ];
  for (const selector of variants) {
    const saved = await response<Receipt>(await w.create(items, { ...item, code: 'ZZ_BE16_' + selector.kind }), 201);
    await response(
      await w.create(rules, {
        itemId: saved.id,
        name: 'ZZ_BE16_RULE',
        priority: 1,
        orgIds: [w.org.id],
        assignees: [selector],
      }),
      201,
    );
  }
  const result = await withTenant(w.db, w.tenant, (tx) =>
    launchEntryPreparations(
      tx,
      portContext(w, 0),
      {
        caseId: stage!.id,
        caseRevision: stage!.revision,
        employeeId: target.id,
        businessId: entry.id,
        businessRevision: entry.revision,
      },
      'auto',
    ),
  );
  expect(result.map(({ status }) => status)).toEqual(variants.map(() => 'open'));
  const visible = await withTenant(w.db, w.tenant, (tx) =>
    listMyPreparations(tx, w.tenant, recipient, { limit: 50, offset: 0 }),
  );
  expect(visible.map(({ id }) => id).sort()).toEqual(
    result.flatMap((row) => ('taskId' in row ? [row.taskId] : [])).sort(),
  );
});

it('AC-EN-03 AC-EN-BE16-06 改期重排已领取的发起候选、保留已办并重算提醒日', async () => {
  const w = await world('ZZ_BE16_PREP_POSTPONE');
  const entry = await addPending(w, '2026-10-08', 'ZZ_BE16_PREP_POSTPONE');
  const [stage] = await withTenant(w.db, w.tenant, (tx) => tx.select().from(onboardingEntryCases));
  const ref = {
    caseId: stage!.id,
    caseRevision: stage!.revision,
    employeeId: entry.employee.id,
    businessId: entry.recordId,
    businessRevision: entry.business.revision,
  };
  const config = async (code: string, startDaysBefore: number | null) => {
    const row = await response<Receipt>(await w.create(items, { ...item, code }), 201);
    await response(
      await w.create(rules, {
        itemId: row.id,
        name: 'ZZ_BE16_START',
        priority: 1,
        orgIds: [w.org.id],
        startDaysBefore,
        remindDaysBefore: 2,
        assignees: [{ kind: 'member', id: w.user }],
      }),
      201,
    );
    return row.id;
  };
  const [scheduled, open, completed] = [
    await config('ZZ_BE16_SCHEDULED', 3),
    await config('ZZ_BE16_OPEN', null),
    await config('ZZ_BE16_DONE', null),
  ];
  await withTenant(w.db, w.tenant, async (tx) => {
    await launchEntryPreparations(tx, portContext(w, 0), ref, 'auto');
    await tx
      .update(onboardingPreparationTasks)
      .set({
        status: 'completed',
        completedBy: w.user,
        completedAt: now,
        nextRemindOn: null,
        result: { remark: 'ZZ_BE16_DONE' },
      })
      .where(and(eq(onboardingPreparationTasks.tenantId, w.tenant), eq(onboardingPreparationTasks.itemId, completed)));
  });
  const due = (date: string) => withTenant(w.db, w.tenant, (tx) => listDuePreparations(tx, w.tenant, date, 10));
  const [claimed] = await due('2026-10-05');
  expect(claimed).toMatchObject(ref);
  const postponed = await response<{ id: string }>(
    await entryAction(w, entry.recordId, 'postpone', { effectiveDate: '2026-10-18' }),
    200,
  );
  await expect(
    withTenant(w.db, w.tenant, (tx) => launchEntryPreparations(tx, portContext(w, 0), claimed!, 'auto', [scheduled])),
  ).rejects.toBeDefined();
  expect(await due('2026-10-05')).toEqual([]);
  expect(await due('2026-10-15')).toMatchObject([{ businessId: postponed.id, caseRevision: ref.caseRevision + 1 }]);
  const state = await withTenant(w.db, w.tenant, (tx) =>
    tx.select().from(onboardingPreparationTasks).where(eq(onboardingPreparationTasks.caseId, stage!.id)),
  );
  expect(state).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ itemId: scheduled, status: 'scheduled', nextDueOn: '2026-10-15' }),
      expect.objectContaining({ itemId: open, status: 'open', nextRemindOn: '2026-10-16' }),
      expect.objectContaining({ itemId: completed, status: 'completed', result: { remark: 'ZZ_BE16_DONE' } }),
    ]),
  );
  expect(await response(await w.session.request('GET', '/pending-entries?view=all'), 200)).toMatchObject({
    items: [{ id: postponed.id, preparationStatus: 'in_progress' }],
  });
  const cancelled = await entryAction(w, postponed.id, 'cancel', {});
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  expect(await response(await w.session.request('GET', '/pending-entries?view=cancelled'), 200)).toMatchObject({
    items: [{ id: postponed.id, preparationStatus: 'closed' }],
  });
  expect(
    await withTenant(w.db, w.tenant, (tx) =>
      tx.select().from(onboardingPreparationTasks).where(eq(onboardingPreparationTasks.itemId, completed)),
    ),
  ).toEqual([expect.objectContaining({ status: 'completed', result: { remark: 'ZZ_BE16_DONE' } })]);
});

it('AC-EN-BE16-06 从上一结构升级，准备表为空且全部启用 FORCE RLS', async () => {
  const legacy = await createTestDb({ migrateBefore: '_be16_preparation' });
  try {
    const { tenant } = await seedTenantWithMember(legacy.db, 'ZZ_BE16_PREP_UPGRADE');
    const tables = () =>
      withTenant(legacy.db, tenant.id, async (tx) =>
        rowsOf<{ enabled: boolean; forced: boolean }>(
          await tx.execute(sql`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind='r'
          AND left(relname, length('onboarding_preparation_')) = 'onboarding_preparation_'
      `),
        ),
      );
    expect(await tables()).toEqual([]);
    await legacy.migrate();
    expect(await tables()).toEqual(Array.from({ length: 6 }, () => ({ enabled: true, forced: true })));
    expect(await withTenant(legacy.db, tenant.id, (tx) => tx.select().from(onboardingPreparationTasks))).toEqual([]);
  } finally {
    await legacy.close();
  }
}, 120_000);
