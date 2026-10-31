/** F-263 / DEC-684⑤⑥：退休固定年龄条件复用租户用工形式字典，国籍保持，人员类别后补 F-323。 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { batchWorld } from './AC-RT-batch-support.js';

const database = useTestDb();
interface Condition {
  fieldCode: string;
  operator: string;
  values: string[];
}
interface Rule {
  id: string;
  revision: number;
  conditions: Condition[];
  enabled: boolean;
}
interface Form {
  id: string;
  code: string;
  name: string;
  revision: number;
}
const condition = (fieldCode: string, values: string[]): Condition => ({ fieldCode, operator: 'in', values });
const internal = condition('employType', ['internal']);

async function world(label: string) {
  const w = await batchWorld(database().db, `f263-${label}`);
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: w.session.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
      { modules: ['employment-retirement'] },
    ),
  );
  const body = (conditions: Condition[], extra: Record<string, unknown> = {}) => ({
    name: '合成固定年龄规则',
    priority: 1,
    orgIds: [w.org.id],
    retirementAgeYears: 60,
    conditions: [internal, ...conditions],
    ...extra,
  });
  const create = (conditions: Condition[], extra: Record<string, unknown> = {}) =>
    w.session.request('POST', '/retirement-rules', { ifMatch: 0, body: body(conditions, extra) });
  async function saved(conditions: Condition[], extra: Record<string, unknown> = {}) {
    const r = await create(conditions, extra);
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as Rule;
  }
  async function list() {
    const r = await w.session.request('GET', '/retirement-rules');
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { items: Rule[] }).items;
  }
  async function forms() {
    const r = await w.session.request('GET', '/employment-forms');
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { items: Form[] }).items;
  }
  async function disable(code: string) {
    const form = (await forms()).find((item) => item.code === code)!;
    const r = await w.session.request('PUT', `/employment-forms/${form.id}`, {
      ifMatch: form.revision,
      body: { enabled: false },
    });
    expect(r.status, await r.clone().text()).toBe(200);
  }
  async function member(code: string | null, nationality = 'CN') {
    const employee = await w.session.employee('合成规则员工');
    await w.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.org.id, employType: 'internal', employmentForm: code },
      },
      employee.revision,
    );
    await w.setPerson(employee.id, { birthday: '1975-06-10', gender: 'male', nationality });
    return employee.id;
  }
  async function run() {
    const r = await w.session.request('POST', '/retirement-rules/run?purpose=expected_date', {
      ifMatch: 0,
      body: {},
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const receipt = (await r.json()) as {
      updated: { employeeId: string; ruleId: string | null }[];
      failed: unknown[];
    };
    expect(receipt.failed).toEqual([]);
    return receipt;
  }
  return { ...w, body, create, saved, list, forms, disable, member, run };
}

async function invalid(response: Response, reason: string) {
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: 'EMPLOYMENT_FORM_INVALID', details: { field: 'employmentForm', reason } },
  });
}

describe('AC-RT-F263 固定年龄用工形式条件', () => {
  it('AC-RT-F263-01：五槽及多编码保存、读取、修改、复制与同键重放保持编码', async () => {
    const w = await world('save');
    const conditions = [
      condition('gender', ['male']),
      condition('nationality', ['CN']),
      condition('identityType', ['10', '20']),
      condition('employmentForm', ['regular', 'temporary']),
    ];
    const key = randomUUID();
    const options = { ifMatch: 0, idempotencyKey: key, body: w.body(conditions) };
    const response = await w.session.request('POST', '/retirement-rules', options);
    expect(response.status, await response.clone().text()).toBe(201);
    const rule = (await response.json()) as Rule;
    expect(rule.conditions).toEqual([conditions[0], conditions[1], internal, conditions[2], conditions[3]]);
    const replay = await w.session.request('POST', '/retirement-rules', options);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(rule);
    expect((await w.list()).find((item) => item.id === rule.id)).toEqual(rule);
    const next = [condition('employmentForm', ['temporary'])];
    const edited = await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: w.body(next),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ revision: 2, conditions: [internal, ...next] });
    const copied = await w.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    expect(await copied.json()).toMatchObject({ enabled: false, conditions: [internal, ...next] });
  });

  it.each(['unknown', 'foreign', 'disabled'] as const)(
    'AC-RT-F263-02：%s 编码混入多选时新增与修改均 422，整份规则不变',
    async (kind) => {
      const w = await world(kind);
      const existing = await w.saved([]);
      let code = 'unknown_form';
      if (kind === 'foreign') {
        const other = await world('foreign-owner');
        code = 'foreign_form';
        const r = await other.session.request('POST', '/employment-forms', {
          ifMatch: 0,
          body: {
            code,
            name: '外租户合成字典项',
            category: null,
            displayOrder: 0,
            effectiveDate: '2020-01-01',
            expiryDate: '9999-12-31',
            enabled: true,
          },
        });
        expect(r.status, await r.clone().text()).toBe(201);
        expect((await w.forms()).some((item) => item.code === code)).toBe(false);
      } else if (kind === 'disabled') {
        code = 'temporary';
        await w.disable(code);
      }
      const before = await w.list();
      const conditions = [condition('employmentForm', ['regular', code])];
      const reason = kind === 'disabled' ? 'EMPLOYMENT_FORM_DISABLED' : 'EMPLOYMENT_FORM_UNKNOWN';
      await invalid(await w.create(conditions), reason);
      await invalid(
        await w.session.request('PUT', `/retirement-rules/${existing.id}`, {
          ifMatch: existing.revision,
          body: w.body(conditions),
        }),
        reason,
      );
      expect(await w.list()).toEqual(before);
    },
  );

  it('AC-RT-F263-03：人员类别明确暂不支持，国籍及无用工形式旧规则行为不变', async () => {
    const w = await world('compat');
    const old = await w.saved([condition('nationality', ['CN'])]);
    const before = await w.list();
    const rejected = await w.create([condition('employmentType', ['synthetic-category'])]);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('人员类别条件暂不支持，后补 F-323');
    expect(await w.list()).toEqual(before);
    const cn = await w.member(null);
    const other = await w.member('regular', 'ZZ');
    await w.setSwitch('expected_date', true);
    const result = await w.run();
    expect(result.updated).toContainEqual(expect.objectContaining({ employeeId: cn, ruleId: old.id }));
    expect((await w.personOf(cn)).expected).toBe('2035-06-30');
    expect((await w.personOf(other)).expected).toBeNull();
  });

  it('AC-RT-F263-04：多编码为或、槽位间为且；不匹配及空编码回落旧规则', async () => {
    const w = await world('compute');
    const rule = await w.saved([
      condition('employmentForm', ['regular', 'temporary']),
      condition('nationality', ['CN']),
    ]);
    const fallback = await w.saved([], { priority: 2, retirementAgeYears: 55 });
    const matched = [await w.member('regular'), await w.member('temporary')];
    const missed = [await w.member('outsourced'), await w.member(null), await w.member('regular', 'ZZ')];
    await w.setSwitch('expected_date', true);
    const result = await w.run();
    for (const employeeId of matched) {
      expect(result.updated).toContainEqual(expect.objectContaining({ employeeId, ruleId: rule.id }));
      expect((await w.personOf(employeeId)).expected).toBe('2035-06-30');
    }
    for (const employeeId of missed) {
      expect(result.updated).toContainEqual(expect.objectContaining({ employeeId, ruleId: fallback.id }));
      expect((await w.personOf(employeeId)).expected).toBe('2030-06-30');
    }
  });

  it('AC-RT-F263-05：保存后停用字典不改旧规则且仍计算命中；重新保存及复制拒绝停用编码', async () => {
    const w = await world('disable-after-save');
    const rule = await w.saved([condition('employmentForm', ['regular'])]);
    const employeeId = await w.member('regular');
    const before = await w.list();
    await w.disable('regular');
    expect(await w.list()).toEqual(before);
    await w.setSwitch('expected_date', true);
    const result = await w.run();
    expect(result.updated).toContainEqual(expect.objectContaining({ employeeId, ruleId: rule.id }));
    expect((await w.personOf(employeeId)).expected).toBe('2035-06-30');
    await invalid(
      await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
        ifMatch: rule.revision,
        body: w.body([condition('employmentForm', ['regular'])]),
      }),
      'EMPLOYMENT_FORM_DISABLED',
    );
    await invalid(
      await w.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 }),
      'EMPLOYMENT_FORM_DISABLED',
    );
    expect(await w.list()).toEqual(before);
  });

  it('AC-RT-F263-06：规则与字典查询按租户隔离，外租户规则不能复制或修改', async () => {
    const owner = await world('owner');
    const other = await world('other');
    const rule = await owner.saved([condition('employmentForm', ['regular'])]);
    const before = await owner.list();
    const otherBefore = await other.list();
    expect(otherBefore.some((item) => item.id === rule.id)).toBe(false);
    const copied = await other.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 });
    expect(copied.status).toBe(404);
    const edited = await other.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: other.body([condition('employmentForm', ['regular'])]),
    });
    expect(edited.status).toBe(404);
    expect(await owner.list()).toEqual(before);
    expect(await other.list()).toEqual(otherBefore);
  });
});
