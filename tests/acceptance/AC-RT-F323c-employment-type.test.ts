/** F-323c / DEC-706：退休固定年龄条件补「人员类别」槽位，按人员类别字典 ID 校验（口径同 F-321 用工形式）。 */
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
}
interface TypeItem {
  id: string;
  name: string;
  revision: number;
}
const condition = (fieldCode: string, values: string[]): Condition => ({ fieldCode, operator: 'in', values });
const internal = condition('employType', ['internal']);

async function world(label: string) {
  const w = await batchWorld(database().db, `f323c-${label}`);
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: w.session.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
      { modules: ['employment-retirement', 'employment-types'] },
    ),
  );
  const body = (conditions: Condition[], extra: Record<string, unknown> = {}) => ({
    name: '合成人员类别规则',
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
  async function types() {
    const r = await w.session.request('GET', '/employment-types?view=all');
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { items: TypeItem[] }).items;
  }
  async function disable(item: TypeItem) {
    const r = await w.session.request('POST', `/employment-types/${item.id}/disable`, { ifMatch: item.revision });
    expect(r.status, await r.clone().text()).toBe(200);
  }
  async function member(employmentType: string | null) {
    const employee = await w.session.employee('合成规则员工');
    await w.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.org.id, employType: 'internal', employmentType },
      },
      employee.revision,
    );
    await w.setPerson(employee.id, { birthday: '1975-06-10', gender: 'male', nationality: 'CN' });
    return employee.id;
  }
  async function run() {
    const r = await w.session.request('POST', '/retirement-rules/run?purpose=expected_date', {
      ifMatch: 0,
      body: {},
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const receipt = (await r.json()) as { updated: { employeeId: string; ruleId: string | null }[]; failed: unknown[] };
    expect(receipt.failed).toEqual([]);
    return receipt;
  }
  return { ...w, body, create, saved, list, types, disable, member, run };
}

async function invalid(response: Response, reason: string) {
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: 'EMPLOYMENT_TYPE_INVALID', details: { field: 'employmentType', reason } },
  });
}

describe('AC-RT-F323c 固定年龄人员类别条件', () => {
  it('AC-RT-F323c-01：人员类别槽位排在用工形式之后，保存、修改、复制与同键重放保持字典 ID', async () => {
    const w = await world('save');
    const [first, second] = await w.types();
    const form = condition('employmentForm', ['regular']);
    const slot = condition('employmentType', [first!.id, second!.id]);
    const key = randomUUID();
    const options = { ifMatch: 0, idempotencyKey: key, body: w.body([form, slot]) };
    const response = await w.session.request('POST', '/retirement-rules', options);
    expect(response.status, await response.clone().text()).toBe(201);
    const rule = (await response.json()) as Rule;
    expect(rule.conditions).toEqual([internal, form, slot]);
    const replay = await w.session.request('POST', '/retirement-rules', options);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(rule);
    const next = condition('employmentType', [second!.id]);
    const edited = await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: w.body([next]),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ revision: 2, conditions: [internal, next] });
    const copied = await w.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    expect(await copied.json()).toMatchObject({ enabled: false, conditions: [internal, next] });
  });

  it.each(['unknown', 'foreign', 'disabled', 'text'] as const)(
    'AC-RT-F323c-02：%s 人员类别混入多选时新增与修改均 422，整份规则不变',
    async (kind) => {
      const w = await world(kind);
      const [valid, other] = await w.types();
      const existing = await w.saved([]);
      let id = randomUUID();
      if (kind === 'foreign') {
        const owner = await world('foreign-owner');
        id = (await owner.types())[0]!.id;
        expect((await w.types()).some((item) => item.id === id)).toBe(false);
      } else if (kind === 'disabled') {
        id = other!.id;
        await w.disable(other!);
      } else if (kind === 'text') id = '合成名称文本';
      const before = await w.list();
      const conditions = [condition('employmentType', [valid!.id, id])];
      const reason = kind === 'disabled' ? 'EMPLOYMENT_TYPE_DISABLED' : 'EMPLOYMENT_TYPE_UNKNOWN';
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

  it('AC-RT-F323c-03：多类别为或、与其他槽位为且；不匹配及空类别回落旧规则', async () => {
    const w = await world('compute');
    const [a, b, c] = await w.types();
    const rule = await w.saved([condition('employmentType', [a!.id, b!.id])]);
    const fallback = await w.saved([], { priority: 2, retirementAgeYears: 55 });
    const matched = [await w.member(a!.id), await w.member(b!.id)];
    const missed = [await w.member(c!.id), await w.member(null)];
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

  it('AC-RT-F323c-04：保存后停用字典项不改旧规则且仍命中；重新保存及复制拒绝停用项', async () => {
    const w = await world('disable-after-save');
    const [item] = await w.types();
    const rule = await w.saved([condition('employmentType', [item!.id])]);
    const employeeId = await w.member(item!.id);
    const before = await w.list();
    await w.disable(item!);
    expect(await w.list()).toEqual(before);
    await w.setSwitch('expected_date', true);
    const result = await w.run();
    expect(result.updated).toContainEqual(expect.objectContaining({ employeeId, ruleId: rule.id }));
    expect((await w.personOf(employeeId)).expected).toBe('2035-06-30');
    const stale = w.body([condition('employmentType', [item!.id])]);
    await invalid(
      await w.session.request('PUT', `/retirement-rules/${rule.id}`, { ifMatch: rule.revision, body: stale }),
      'EMPLOYMENT_TYPE_DISABLED',
    );
    await invalid(
      await w.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 }),
      'EMPLOYMENT_TYPE_DISABLED',
    );
    expect(await w.list()).toEqual(before);
  });
});
