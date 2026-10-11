/** B6：参评条件随活动整份保存，B2 校验、EV-R14、字段权限、幂等与审计（设计 §3.2；D-068）。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import {
  ACTIVITIES,
  activityFixtures,
  activityOperator,
  activityWorld,
  type ActivityFixtures,
  type ActivityView,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { EV_BASE, EV_NOW, errorOf, ok } from './AC-EV-support.js';

const testDb = useTestDb();
type Condition = {
  kind: string;
  applicantKind: string;
  categoryIds: string[];
  levelIds: string[];
  expression: string | null;
  details: {
    seq: number;
    source: string;
    field: string;
    operator: string;
    value1: string | number | null;
    value2: string | number | null;
  }[];
};
type Activity = ActivityView & { conditions: Condition[] };

describe('AC-EV-conditions 活动参评条件', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });
  const detail = (seq = 1, extra: Record<string, unknown> = {}) => ({
    seq,
    source: 'employee',
    field: 'age',
    operator: 'ge',
    value1: 18,
    value2: null,
    ...extra,
  });
  const condition = (extra: Record<string, unknown> = {}) => ({
    kind: 'common',
    applicantKind: 'self',
    categoryIds: [],
    levelIds: [],
    expression: null,
    details: [detail()],
    ...extra,
  });
  const create = (conditions: unknown[] = [condition()]) =>
    w.adminActivity(f.body({ applicants: ['self', 'others'], conditions })) as Promise<Activity>;
  const read = (id: string) => w.adminRead(id) as Promise<Activity>;
  const patch = (activity: ActivityView, body: unknown, extra = {}) =>
    w.setup.request('PATCH', `${EV_BASE}${ACTIVITIES}/${activity.id}`, {
      ...w.asAdmin,
      ifMatch: activity.revision,
      body,
      ...extra,
    });
  const count = async (table: 'ev_conditions' | 'ev_condition_details') =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]!.n);
    });

  it('通用 / 附加 × 本人 / 非本人整份保存，来源 / 字段、数字 / 文本 / 日期与表达式完整回读', async () => {
    const conditions = [
      condition({
        expression: '条件1 and 条件2',
        details: [
          detail(),
          detail(2, {
            source: 'employment',
            field: 'entryDate',
            operator: 'between',
            value1: '2026-01-01',
            value2: '2026-09-30',
          }),
        ],
      }),
      condition({ applicantKind: 'others', details: [detail(1, { operator: 'ne', value1: 'xyz' })] }),
      ...['self', 'others'].map((applicantKind) =>
        condition({
          kind: 'extra',
          applicantKind,
          categoryIds: [f.cat1.id],
          levelIds: [f.lv1.id],
          expression: '条件1',
          details: [detail(1, { source: 'personnel.education', field: 'degree', operator: 'eq', value1: '本科' })],
        }),
      ),
    ];
    const activity = await create(conditions);
    expect(activity.conditions).toEqual(conditions);
    expect(await read(activity.id)).toEqual(activity);
    const page = await ok<{ items: Activity[] }>(await w.setup.request('GET', `${EV_BASE}${ACTIVITIES}`, w.asAdmin));
    expect(page.items.find((item) => item.id === activity.id)?.conditions).toEqual(conditions);
    const changed = await ok<Activity>(
      await patch(activity, { name: '条件与活动一起修改', conditions: [condition()] }),
    );
    expect(changed).toMatchObject({ revision: 2, name: '条件与活动一起修改', conditions: [condition()] });
    const renamed = await ok<Activity>(await patch(changed, { name: '省略条件保留' }));
    expect(renamed.conditions).toEqual(changed.conditions);
    const cleared = await ok<Activity>(await patch(renamed, { conditions: [] }));
    expect((await read(cleared.id)).conditions).toEqual([]);
  });

  it.each([
    ['条件1 and 条件9', 'CONDITION_SEQ_UNKNOWN'],
    ['条件1 and (', 'EXPRESSION_SYNTAX'],
    ['   ', 'EXPRESSION_EMPTY'],
    ['JudgeAverage() > 0', 'EXPRESSION_FUNCTION_NOT_ALLOWED'],
  ])('非法组合表达式 %s → 400 且定位条件组；活动和条件整体不变', async (expression, code) => {
    const activity = await create();
    const response = await patch(activity, { name: '不得落库', conditions: [condition({ expression })] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: {
          reason: 'CONDITION_EXPRESSION_INVALID',
          conditionIndex: 0,
          errors: [{ code }],
        },
      },
    });
    expect(await read(activity.id)).toEqual(activity);
  });

  it.each([
    [{ operator: 'between', value1: '2026-09-30', value2: '2026-09-01' }, 'RANGE_INVERTED'],
    [{ operator: 'between', value1: 5, value2: 1 }, 'RANGE_INVERTED'],
    [{ operator: 'eq', value1: '' }, 'VALUE_REQUIRED'],
    [{ operator: 'ne', value1: '  ' }, 'VALUE_REQUIRED'],
    [{ operator: 'between', value2: null }, 'VALUE_REQUIRED'],
    [{ operator: 'eq', value2: '多余值' }, 'VALUE_NOT_ALLOWED'],
    [{ operator: 'contains' }, 'OPERATOR_INVALID'],
  ])('D-068 与 B2 明细校验：%j → 400、条件组与序号定位、可读提示、整份回滚', async (extra, code) => {
    const activity = await create();
    const response = await patch(activity, {
      name: '不得落库',
      conditions: [condition({ details: [detail(7, extra)] })],
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.any(String),
        details: {
          reason: 'CONDITION_DETAILS_INVALID',
          conditionIndex: 0,
          issues: [{ seq: 7, code }],
        },
      },
    });
    expect(await read(activity.id)).toEqual(activity);
  });

  it('重复明细序号拒绝；为空 / 不为空无比较值、范围两端相等、数字 0 与文本 "0" 可保存', async () => {
    const activity = await create();
    const bad = await patch(activity, { conditions: [condition({ details: [detail(), detail()] })] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { details: { issues: [{ code: 'SEQ_DUPLICATE' }] } } });
    expect(await read(activity.id)).toEqual(activity);
    const details = [
      detail(1, { operator: 'is_empty', value1: null }),
      detail(2, { operator: 'not_empty', value1: null }),
      detail(3, { operator: 'between', value1: '2026-01-01', value2: '2026-01-01' }),
      detail(4, { operator: 'eq', value1: 0 }),
      detail(5, { operator: 'eq', value1: '0' }),
    ];
    const after = await ok<Activity>(await patch(activity, { conditions: [condition({ details })] }));
    expect(after.conditions[0]!.details).toEqual(details);
    expect((await read(activity.id)).conditions).toEqual(after.conditions);
  });

  it('超出存储整数范围的序号在入口返回 400，不能落到数据库错误；新建非法条件也不留下活动', async () => {
    const activity = await create();
    const response = await patch(activity, { conditions: [condition({ details: [detail(2_147_483_648)] })] });
    expect(response.status).toBe(400);
    expect(await read(activity.id)).toEqual(activity);
    const body = f.body({ name: '非法条件不得新建', conditions: [condition({ expression: '条件99' })] });
    const before = [await count('ev_conditions'), await count('ev_condition_details')];
    const created = await w.setup.request('POST', `${EV_BASE}${ACTIVITIES}`, { ...w.asAdmin, ifMatch: 0, body });
    expect(created.status).toBe(400);
    expect((await errorOf(created)).reason).toBe('CONDITION_EXPRESSION_INVALID');
    const page = await ok<{ items: Activity[] }>(await w.setup.request('GET', `${EV_BASE}${ACTIVITIES}`, w.asAdmin));
    expect(page.items.some((item) => item.name === body.name)).toBe(false);
    expect([await count('ev_conditions'), await count('ev_condition_details')]).toEqual(before);
  });

  it('附加范围的新增类别 / 级别引用复用 B5 校验：不存在 404、无查看权 403、停用 400，整份回滚', async () => {
    const activity = await create();
    const missing = await patch(activity, { conditions: [condition({ kind: 'extra', levelIds: [randomUUID()] })] });
    expect(missing.status).toBe(404);
    expect(await read(activity.id)).toEqual(activity);
    const category = await w.qlCategory();
    const op = await activityOperator(w, { evOrgs: [w.orgA], noCategoryObject: true });
    const body = { conditions: [condition({ kind: 'extra', categoryIds: [category.id] })] };
    expect(
      (await op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body })).status,
    ).toBe(403);
    expect(await read(activity.id)).toEqual(activity);
    await w.disableQl('categories', category);
    const disabled = await patch(activity, body);
    expect(disabled.status).toBe(400);
    expect((await errorOf(disabled)).reason).toBe('REFERENCE_DISABLED');
    expect(await read(activity.id)).toEqual(activity);
  });

  it('EV-R14：已发布且已有报名时可整份替换条件，仍拒绝增删环节；完成后条件只读', async () => {
    const activity = await create();
    await w.setStatus(activity.id, 'published');
    await w.setApplyCount(activity.id, 1);
    const changed = await ok<Activity>(await patch(activity, { conditions: [condition({ applicantKind: 'others' })] }));
    expect(changed.conditions[0]!.applicantKind).toBe('others');
    const denied = await patch(changed, {
      conditions: [],
      chains: f.chains().filter((chain) => chain.type !== 'material'),
    });
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).reason).toBe('ACTIVITY_HAS_APPLICANTS');
    expect(await read(activity.id)).toEqual(changed);
    await w.setStatus(activity.id, 'completed');
    const before = await read(activity.id);
    expect((await patch(changed, { conditions: [] })).status).toBe(409);
    expect(await read(activity.id)).toEqual(before);
  });

  it('字段权限：详情 / 列表 / 写响应 / 重放裁剪整份条件，显式清空要编辑权；范围外 404', async () => {
    const activity = await create();
    const hidden = await activityOperator(w, { evOrgs: [w.orgA], hidden: ['conditions'] });
    const path = `${ACTIVITIES}/${activity.id}`;
    expect(await ok(await hidden.request('GET', path))).not.toHaveProperty('conditions');
    const page = await ok<{ items: Record<string, unknown>[] }>(await hidden.request('GET', ACTIVITIES));
    expect(page.items.find((item) => item.id === activity.id)).not.toHaveProperty('conditions');
    const key = randomUUID();
    const send = () =>
      hidden.request('PATCH', path, { ifMatch: activity.revision, idempotencyKey: key, body: { name: '隐藏条件' } });
    expect(await ok(await send())).not.toHaveProperty('conditions');
    expect(await ok(await send())).not.toHaveProperty('conditions');
    const before = await read(activity.id);
    expect((await hidden.request('PATCH', path, { ifMatch: before.revision, body: { conditions: [] } })).status).toBe(
      403,
    );
    expect(await read(activity.id)).toEqual(before);
    const readonly = await activityOperator(w, { evOrgs: [w.orgA], readonly: ['conditions'] });
    expect((await readonly.request('PATCH', path, { ifMatch: before.revision, body: { conditions: [] } })).status).toBe(
      403,
    );
    expect(await read(activity.id)).toEqual(before);
    const outside = await activityOperator(w, { evOrgs: [w.orgB] });
    expect((await outside.request('GET', path)).status).toBe(404);
    expect((await outside.request('PATCH', path, { ifMatch: before.revision, body: { conditions: [] } })).status).toBe(
      404,
    );
    expect(await read(activity.id)).toEqual(before);
  });

  it('同键重放不重复落条件；过期 revision / 同键异内容不覆盖；删除清理子表并保留审计快照', async () => {
    const initial = await create();
    const key = randomUUID();
    const body = { conditions: [condition({ expression: '条件1' })] };
    const counts = [await count('ev_conditions'), await count('ev_condition_details')];
    const changed = await ok<Activity>(await patch(initial, body, { idempotencyKey: key }));
    expect(await ok(await patch(initial, body, { idempotencyKey: key }))).toEqual(changed);
    expect([await count('ev_conditions'), await count('ev_condition_details')]).toEqual(counts);
    expect((await patch(initial, { conditions: [] })).status).toBe(409);
    expect((await patch(initial, { conditions: [] }, { idempotencyKey: key })).status).toBe(409);
    expect(await read(initial.id)).toEqual(changed);
    const removed = await w.setup.request('DELETE', `${EV_BASE}${ACTIVITIES}/${initial.id}`, {
      ...w.asAdmin,
      ifMatch: changed.revision,
    });
    expect(await ok<Activity>(removed)).toEqual(changed);
    expect([await count('ev_conditions'), await count('ev_condition_details')]).toEqual(counts.map((n) => n - 1));
    const audit = auditApi(testDb().db, () => EV_NOW);
    const logs = await audit.dataChanges(w.asAdmin, {
      objectId: initial.id,
      action: 'evaluation.activity.delete',
    });
    const log = logs.items.find(
      (item) => item.objectId === initial.id && item.action === 'evaluation.activity.delete',
    )!;
    expect(log).toBeDefined();
    const snapshot = await audit.dataChange(w.asAdmin, log.id);
    expect(snapshot.before).toMatchObject({ conditions: changed.conditions });
  });
});
