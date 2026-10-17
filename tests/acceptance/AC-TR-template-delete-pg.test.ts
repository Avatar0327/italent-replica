/** F-094 / B6b：真实 HTTP 事务持锁后交错；TR-R12 / TR-R20、DEC-436。 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as config from '../../apps/api/src/modules/talent-review/config-kit.js';
import type { ConfigSpec } from '../../apps/api/src/modules/talent-review/config-kit.js';
import * as structure from '../../apps/api/src/modules/talent-review/template-structure.js';
import { SCORE_RULE } from '../../apps/api/src/modules/talent-review/score-rule-service.js';
import { MODULE_GRADE } from '../../apps/api/src/modules/talent-review/module-grade-service.js';
import { FIELD } from '../../apps/api/src/modules/talent-review/field-service.js';
import { FLOW } from '../../apps/api/src/modules/talent-review/flow-service.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { rowsOf } from './support/f048.js';
import { formBody } from './AC-TR-form-flow-support.js';
import {
  indicatorModule,
  templateBody,
  templateWorld,
  type TemplateView,
  type TemplateWorld,
} from './AC-TR-template-support.js';

const testDb = useTestDb();
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

function pauseVersion() {
  const entered = barrier(),
    resume = barrier();
  const original = structure.writeVersion;
  const spy = vi.spyOn(structure, 'writeVersion').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return original(...args);
  });
  return { entered, resume, spy };
}

/** deleteConfig 已 FOR UPDATE，再加载删除快照；按对象过滤，不截获模板的来源读取。 */
function pauseConfigDelete(object: Kind, id: string) {
  const entered = barrier(),
    resume = barrier();
  const spec: ConfigSpec<{ id: string }> = {
    scoreRule: SCORE_RULE,
    moduleGrade: MODULE_GRADE,
    field: FIELD,
    flow: FLOW,
  }[object];
  const original = spec.load!;
  const spy = vi.spyOn(spec, 'load').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === id) {
      entered.resolve();
      await resume.promise;
    }
    return result;
  });
  return { entered, resume, spy };
}

/** deleteTemplate 已 FOR UPDATE 且读完原件，引用守卫前暂停。 */
function pauseTemplateDelete(id: string) {
  const entered = barrier(),
    resume = barrier();
  const original = config.configReferrer;
  const spy = vi.spyOn(config, 'configReferrer').mockImplementation(async (...args) => {
    if (args[2] === 'template' && args[3] === id) {
      entered.resolve();
      await resume.promise;
    }
    return original(...args);
  });
  return { entered, resume, spy };
}

type Pause = Pick<ReturnType<typeof pauseVersion>, 'entered' | 'resume'> & { spy: { mockRestore(): void } };

async function interleave(db: Db, pause: Pause, start: () => Promise<Response>, contend: () => Promise<Response>) {
  const first = start();
  let second: Promise<Response> | undefined;
  let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pause.entered.promise,
      new Promise<never>((_resolve, reject) => {
        arrivalTimer = setTimeout(() => reject(new Error('等待请求到持锁边界超时')), 5_000);
      }),
      first.then(async (response) => {
        throw new Error(`请求未到持锁边界即结束：${response.status} ${await response.clone().text()}`);
      }),
    ]);
    clearTimeout(arrivalTimer);
    second = contend();
    await waitForBlocked(db, 1);
    pause.resume.resolve();
    return [await first, await second] as const;
  } finally {
    clearTimeout(arrivalTimer);
    pause.resume.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    pause.spy.mockRestore();
  }
}

async function status(response: Response, expected: number) {
  expect(response.status, await response.clone().text()).toBe(expected);
}

const KINDS = [
  ['scoreRule', '/score-rules', 'SCORE_RULE_IN_USE'],
  ['moduleGrade', '/module-grades', 'MODULE_GRADE_IN_USE'],
  ['field', '/fields', 'FIELD_IN_USE'],
  ['flow', '/flows', 'FLOW_IN_USE'],
] as const;
type Kind = (typeof KINDS)[number][0];

async function referenceFixture(w: TemplateWorld, kind: Kind) {
  if (kind === 'flow') {
    const { flow } = await w.threeStepFlow();
    return { id: flow.id, body: { flowId: flow.id } };
  }
  if (kind === 'field') {
    const field = await w.field();
    return { id: field.id, body: { modules: [{ kind: 'info', name: '信息', fieldIds: [field.id] }] } };
  }
  const rule = await w.gradeRule();
  if (kind === 'scoreRule') return { id: rule.id, body: { modules: [indicatorModule(rule.id)] } };
  const grade = await w.moduleGrade();
  return { id: grade.id, body: { modules: [indicatorModule(rule.id, { moduleGradeId: grade.id })] } };
}

/** 独立租户内检查全部 13 张模板表；不仅沿已删除父行 JOIN，避免漏掉孤儿行。 */
const TEMPLATE_TABLES = [
  'talent_review_templates',
  'talent_review_template_versions',
  'talent_review_template_steps',
  'talent_review_template_step_roles',
  'talent_review_template_modules',
  'talent_review_template_module_levels',
  'talent_review_template_module_fields',
  'talent_review_template_step_module_permissions',
  'talent_review_template_step_forms',
  'talent_review_template_form_fields',
  'talent_review_template_result_rules',
  'talent_review_template_result_refs',
  'talent_review_template_result_module_refs',
] as const;

async function templateRows(db: Db, tenantId: string) {
  const result = new Map<string, string[]>();
  // 租户表带 RLS：普通角色须在租户上下文里读，裸读只会得到空数组而让“非空 / 已清空”断言失真
  await withTenant(db, tenantId, async (tx) => {
    for (const table of TEMPLATE_TABLES) {
      const rows = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`SELECT * FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}::uuid`),
      );
      result.set(table, rows.map((row) => JSON.stringify(row)).sort());
    }
  });
  return result;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TR-template-delete 真 PG / F-094', () => {
  it.each([false, true])('TR-R12：模板删除 × 复制，删除先持锁=%s', async (deleteFirst) => {
    const db = testDb().db;
    const w = await templateWorld(db, `f094-copy-${deleteFirst}`);
    const rule = await w.gradeRule();
    const field = await w.field({ kind: 'number', name: '来源' });
    const target = await w.field({ kind: 'number' });
    const t = await w.template(
      templateBody(w.orgId, {
        modules: [indicatorModule(rule.id, { name: '业绩' }), { kind: 'info', name: '信息', fieldIds: [field.id] }],
        resultRules: [
          {
            targetFieldId: target.id,
            formula: '模块.业绩.得分 + 盘点对象.来源',
            formulaBindings: [field.id],
            priority: 0,
          },
        ],
      }),
    );
    const remove = () => w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: t.revision });
    const copy = () =>
      w.trRequest('POST', `/templates/${t.id}/copy`, { ifMatch: t.revision, body: { name: '并发副本' } });
    const pause = deleteFirst ? pauseTemplateDelete(t.id) : pauseVersion();
    const [first, second] = await interleave(db, pause, deleteFirst ? remove : copy, deleteFirst ? copy : remove);
    await status(first, deleteFirst ? 200 : 201);
    await status(second, deleteFirst ? 404 : 200);
    expect((await w.read(t.id)).status).toBe(404);
    if (deleteFirst) {
      for (const [table, rows] of await templateRows(db, w.as.tenant)) expect(rows, table).toEqual([]);
    } else {
      const duplicate = (await first.json()) as TemplateView;
      expect(duplicate.id).not.toBe(t.id);
      expect(duplicate.modules.map((m) => m.id).some((id) => t.modules.some((m) => m.id === id))).toBe(false);
      expect((await w.read(duplicate.id)).body).toEqual(duplicate);
      expect(duplicate.resultRules).toEqual(t.resultRules);
      const edited = await w.patch(duplicate, { name: '原件删除后仍独立可编辑' });
      await status(edited, 200);
      await status(await w.trRequest('DELETE', `/templates/${duplicate.id}`, { ifMatch: 2 }), 200);
      for (const [table, rows] of await templateRows(db, w.as.tenant)) expect(rows, table).toEqual([]);
    }
  });

  describe.each(KINDS)('%s 删除 × 模板新增引用', (kind, path, reason) => {
    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])('TR-R20 / DEC-436：删除先持锁=%s，已有历史引用=%s', async (deleteFirst, historical) => {
      const db = testDb().db;
      const w = await templateWorld(db, `f094-${kind}-${deleteFirst}-${historical}`);
      const ref = await referenceFixture(w, kind);
      let t = await w.template(templateBody(w.orgId, historical ? ref.body : {}));
      let history: TemplateView | undefined;
      if (historical) {
        history = (await w.read(t.id, '?version=1')).body;
        const cleared = await w.patch(t, { flowId: null, modules: [] });
        await status(cleared, 200);
        t = (await cleared.json()) as TemplateView;
        expect(t).toMatchObject({ flowId: null, modules: [], currentVersionNo: 2 });
      }
      const before = (await w.read(t.id)).body;
      const configBefore = await (await w.trRequest('GET', `${path}/${ref.id}`)).json();
      const remove = () => w.trRequest('DELETE', `${path}/${ref.id}`, { ifMatch: 1 });
      const reference = () => w.patch(t, ref.body);
      const pause = deleteFirst ? pauseConfigDelete(kind, ref.id) : pauseVersion();
      const [first, second] = await interleave(
        db,
        pause,
        deleteFirst ? remove : reference,
        deleteFirst ? reference : remove,
      );
      const deletion = deleteFirst ? first : second;
      const addition = deleteFirst ? second : first;
      if (deleteFirst && !historical) {
        await status(deletion, 200);
        await status(addition, 404);
        const after = (await w.read(t.id)).body;
        // 删除字段会推进实时目录版本；它不是模板业务修改，其他字段与版本链必须不变。
        expect(after).toEqual({ ...before, fieldCatalogVersion: after.fieldCatalogVersion });
        if (kind !== 'field') expect(after.fieldCatalogVersion).toBe(before.fieldCatalogVersion);
        await status(await w.trRequest('GET', `${path}/${ref.id}`), 404);
      } else {
        await status(deletion, 409);
        expect(await deletion.json()).toMatchObject({ error: { details: { reason } } });
        await status(addition, 200);
        const after = (await w.read(t.id)).body;
        expect(after.revision).toBe(t.revision + 1);
        expect(after.currentVersionNo).toBe(t.currentVersionNo + 1);
        expect(after).toMatchObject(ref.body);
        expect(await (await w.trRequest('GET', `${path}/${ref.id}`)).json()).toEqual(configBefore);
        if (history) {
          const old = (await w.read(t.id, '?version=1')).body;
          expect(old).toMatchObject({
            versionNo: 1,
            flowId: history.flowId,
            modules: history.modules,
            steps: history.steps,
          });
        }
        // 清空当前版本后仍拒删，不能仅靠本次新增的当前引用使交错测试通过。
        const cleared = await w.patch(after, { flowId: null, modules: [] });
        await status(cleared, 200);
        const historicalBefore = (await w.read(t.id)).body;
        const rejected = await remove();
        await status(rejected, 409);
        expect(await rejected.json()).toMatchObject({ error: { details: { reason } } });
        expect((await w.read(t.id)).body).toEqual(historicalBefore);
        expect(await (await w.trRequest('GET', `${path}/${ref.id}`)).json()).toEqual(configBefore);
      }
      const current = (await w.read(t.id)).body;
      await status(await w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: current.revision }), 200);
      if (!(deleteFirst && !historical)) await status(await remove(), 200);
      for (const [table, rows] of await templateRows(db, w.as.tenant)) expect(rows, table).toEqual([]);
    });
  });

  it('DEC-436：删除清理当前及历史全部 13 张模板表，保留同租户另一模板与来源配置', async () => {
    const db = testDb().db;
    const tables = rowsOf<{ table_name: string }>(
      await db.execute(sql`SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND left(table_name, length('talent_review_template'))='talent_review_template'`),
    );
    expect(tables.map((table) => table.table_name).sort()).toEqual([...TEMPLATE_TABLES].sort());
    const w = await templateWorld(db, 'f094-cleanup');
    const { flow } = await w.threeStepFlow();
    const rule = await w.gradeRule();
    const grade = await w.moduleGrade();
    const field = await w.field({ kind: 'number', name: '来源' });
    const target = await w.field({ kind: 'number' });
    const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: field.id }]));
    const body = {
      flowId: flow.id,
      modules: [
        indicatorModule(rule.id, { name: '业绩', moduleGradeId: grade.id }),
        { kind: 'info', name: '信息', fieldIds: [field.id] },
      ],
      stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
      resultRules: [
        {
          targetFieldId: target.id,
          formula: '模块.业绩.得分 + 盘点对象.来源',
          formulaBindings: [field.id],
          priority: 0,
        },
      ],
    };
    const keeper = await w.template(templateBody(w.orgId, body));
    const baseline = await templateRows(db, w.as.tenant);
    const t = await w.template(templateBody(w.orgId, body));
    const changed = await w.patch(t, { permissions: [] });
    await status(changed, 200);
    const current = (await changed.json()) as TemplateView;
    expect(current.currentVersionNo).toBe(2);
    const populated = await templateRows(db, w.as.tenant);
    for (const [table, rows] of populated)
      expect(rows.length, `${table} 必须实际有待清理行`).toBeGreaterThan(baseline.get(table)!.length);
    const sources = [
      `/flows/${flow.id}`,
      `/score-rules/${rule.id}`,
      `/module-grades/${grade.id}`,
      `/fields/${field.id}`,
      `/fields/${target.id}`,
      `/forms/${form.id}`,
    ];
    const beforeSources = await Promise.all(sources.map(async (path) => (await w.trRequest('GET', path)).json()));
    await status(await w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: current.revision }), 200);
    expect((await w.read(t.id)).status).toBe(404);
    expect((await w.read(t.id, '?version=1')).status).toBe(404);
    expect(await templateRows(db, w.as.tenant)).toEqual(baseline);
    expect((await w.read(keeper.id)).body).toEqual(keeper);
    const afterSources = await Promise.all(sources.map(async (path) => (await w.trRequest('GET', path)).json()));
    expect(afterSources).toEqual(beforeSources);
    await status(await w.trRequest('DELETE', `/templates/${keeper.id}`, { ifMatch: keeper.revision }), 200);
    for (const [table, rows] of await templateRows(db, w.as.tenant)) expect(rows, table).toEqual([]);
  });
});
