import { bootstrapTenantAdmin } from '@italent/api';
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  insertRetirementRule,
  parseRetirementRule,
  type RetirementRuleView,
} from '../../apps/api/src/modules/employment/retirement-rules.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const RULES = '/api/tenant/employment/retirement-rules';
const SETTINGS = MODULE_OBJECTS.employmentSettings;
const NOW = new Date('2026-11-20T12:00:00Z');
const ruleCases = [
  {
    label: 'B66 固定年龄',
    purpose: 'expected_date',
    create: { retirementAgeYears: 60, retirementAgeMonths: 2 },
    edit: { retirementAgeYears: 61, retirementAgeMonths: 4 },
    fields: { ruleType: 'fixed_age', earliestFunction: null, latestFunction: null },
  },
  {
    label: 'B67 弹性范围',
    purpose: 'flexible_range',
    create: { earliestFunction: 'statutory_earliest', latestFunction: 'statutory_latest' },
    edit: {
      earliestFunction: 'statutory_earliest',
      latestFunction: 'statutory_latest',
      enabled: false,
      includeSubordinates: false,
    },
    fields: { ruleType: 'builtin', retirementAgeYears: null, retirementAgeMonths: null },
  },
] as const;

type RuleCase = (typeof ruleCases)[number];

async function setup() {
  const db = database().db;
  const { tenant, user: admin } = await seedTenantWithMember(db, 'f536');
  const asAdmin = { tenant: tenant.id, user: admin.id };
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: admin.id }, cmd());
  const api = tenantApi(db, { authorize: undefined, clock: () => NOW });
  const world = { db, tenant, admin, adminRecord, api, asAdmin };

  // 规则回读仍需要独立的任职记录查看权，由真实业务身份提供（R2-T04 §12.1）。
  const reader = await createProfile(world, 'f536-rule-reader');
  const readGrant = await setObjectPermission(
    world,
    reader,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: 'effectiveDate', view: true, edit: false }],
      buttons: [],
    },
    MODULE_OBJECTS.employmentRecord.code,
  );
  expect(readGrant.status, await readGrant.clone().text()).toBe(200);
  await makeGrantable(world, [reader.id]);
  expect((await grant(world, admin.id, reader.id)).status).toBe(201);

  const fixture = tenantApi(db, { clock: () => NOW });
  const org = await fixture.request('POST', '/api/tenant/org/organizations', {
    ...asAdmin,
    ifMatch: 0,
    body: { name: '合成退休规则使用部门', parents: { admin: { parentId: tenant.id } } },
  });
  expect(org.status, await org.clone().text()).toBe(201);
  const { id: orgId } = (await org.json()) as { id: string };
  return { ...world, orgId };
}

let w: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  w = await setup();
});

function bodyFor(rule: RuleCase, name: string) {
  return {
    name,
    purpose: rule.purpose,
    orgIds: [w.orgId],
    priority: 1,
    conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    ...rule.create,
  };
}

function seedRule(rule: RuleCase, name: string) {
  const input = parseRetirementRule(bodyFor(rule, name));
  const scope = { tenantId: w.tenant.id, now: NOW };
  return withTenant(w.db, w.tenant.id, (tx) => insertRetirementRule(tx, scope, input));
}

async function list(purpose: RuleCase['purpose']) {
  const response = await w.api.request('GET', `${RULES}?purpose=${purpose}`, w.asAdmin);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: RetirementRuleView[] }).items;
}

describe.each(ruleCases)('AC-RT-F536 $label', (rule) => {
  it('租户管理员 POST 201，并回读新建字段', async () => {
    const body = bodyFor(rule, '合成新建规则');
    const response = await w.api.request('POST', RULES, { ...w.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as RetirementRuleView;
    expect((await list(rule.purpose)).find((row) => row.id === id)).toMatchObject({
      ...body,
      ...rule.fields,
      expectedFunction: null,
      revision: 1,
    });
    const rights = await w.api.request('GET', `/api/tenant/permission/me/objects/${SETTINGS.code}`, w.asAdmin);
    expect(rights.status).toBe(200);
    expect(await rights.json()).toMatchObject({
      dataOperations: { create: true, update: true, delete: false },
      editableFields: expect.arrayContaining([
        'purpose',
        'ruleType',
        'retirementAgeYears',
        'retirementAgeMonths',
        'expectedFunction',
        'earliestFunction',
        'latestFunction',
      ]),
      buttons: [],
    });
  });

  it('租户管理员 PUT 200，并回读修改后的字段', async () => {
    // 用既有规则隔离 PUT 的红证据，避免被基线 POST 的 403 提前中断。
    const id = await seedRule(rule, '合成待改规则');
    const body = { ...bodyFor(rule, '合成已改规则'), ...rule.edit, priority: 2 };
    const response = await w.api.request('PUT', `${RULES}/${id}`, { ...w.asAdmin, ifMatch: 1, body });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await list(rule.purpose)).find((row) => row.id === id)).toMatchObject({
      ...body,
      ...rule.fields,
      expectedFunction: null,
      revision: 2,
    });
  });

  it('租户管理员复制 201、启停 200、删除 200', async () => {
    const source = await seedRule(rule, '合成待复制规则');
    const copied = await w.api.request('POST', `${RULES}/${source}/copy`, { ...w.asAdmin, ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const { id } = (await copied.json()) as RetirementRuleView;
    expect(id).not.toBe(source);
    expect((await list(rule.purpose)).find((row) => row.id === id)).toMatchObject({
      ...bodyFor(rule, '合成待复制规则（复制）'),
      ...rule.fields,
      expectedFunction: null,
      enabled: false,
      revision: 1,
    });
    for (const [ifMatch, enabled] of [
      [1, true],
      [2, false],
    ] as const) {
      const toggled = await w.api.request('PUT', `${RULES}/${id}/enabled`, {
        ...w.asAdmin,
        ifMatch,
        body: { enabled },
      });
      expect(toggled.status, await toggled.clone().text()).toBe(200);
      expect(await toggled.json()).toMatchObject({ id, enabled, revision: ifMatch + 1 });
    }
    const deleted = await w.api.request('DELETE', `${RULES}/${id}`, { ...w.asAdmin, ifMatch: 3 });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true });
    expect((await list(rule.purpose)).find((row) => row.id === id)).toBeUndefined();
    expect((await list(rule.purpose)).find((row) => row.id === source)).toMatchObject({ enabled: true, revision: 1 });
  });
});

describe('AC-RT-F536 配置写门禁', () => {
  it('普通成员在无业务身份、授予对象和字段权、撤回一项字段权时均返回 403', async () => {
    const member = await addMember(w, '合成普通成员');
    const asMember = { tenant: w.tenant.id, user: member.id };
    const profile = await createProfile(w, 'f536-business-editor');
    const fields = SETTINGS.fields.filter((field) => !field.system);
    async function expectForbidden() {
      for (const rule of ruleCases) {
        const body = bodyFor(rule, '普通成员尝试保存');
        const id = await seedRule(rule, '合成现有规则');
        const post = await w.api.request('POST', RULES, { ...asMember, ifMatch: 0, body });
        expect(post.status).toBe(403);
        expect(await errorCode(post)).toBe('FORBIDDEN');
        const put = await w.api.request('PUT', `${RULES}/${id}`, { ...asMember, ifMatch: 1, body });
        expect(put.status).toBe(403);
        expect(await errorCode(put)).toBe('FORBIDDEN');
      }
    }

    async function setFieldRights(excluded?: string) {
      const result = await setObjectPermission(
        w,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: fields.map(({ code }) => ({ fieldCode: code, view: true, edit: code !== excluded })),
          buttons: [],
        },
        SETTINGS.code,
      );
      expect(result.status, await result.clone().text()).toBe(200);
    }

    await expectForbidden();
    await setFieldRights();
    await makeGrantable(w, [profile.id]);
    expect((await grant(w, member.id, profile.id)).status).toBe(201);
    await expectForbidden();
    await setFieldRights('name');
    await expectForbidden();
  });
});
