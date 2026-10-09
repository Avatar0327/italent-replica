/**
 * PR #125 第 4 轮 P2-2（真升级）：PR-A 留下的计分批次没有记套卷的计分口径版本（升级迁移把 questionnaire_revisions 补成
 * 空对象）。升级后这些批次不能当作“计分口径未变”：报告不能凭历史批次生成；重新启用 → 停用计分之后，再改已使用套卷的
 * 内容 / 权重 / 计分方式，报告列表、管理端与收件人链接查看、生成 / 更新、转发预览 / 发送、Lastest360Cent 都按失效处理。
 *
 * 库先只迁到 PR-B 迁移之前（PR-A 结构），用当前接口造 PR-A 数据：当前接口会读写 PR-B 新增的列与表，前置步骤期间按
 * 升级迁移本身的 SQL 临时补出，跑完即撤掉（与 support/pre-audit-schema 同一做法），再执行真实的 PR-B 升级迁移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, migrationsFolder, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { loadSurvey360Port } from '../../apps/api/src/modules/survey360/port.js';
import type { QuestionnaireView } from './AC-360-support.js';
import { DATA_CHANGED, errorOf, key, outbox, reportLink, sceneB, type SceneB } from './AC-360-B-support.js';

const database = useTestDb({ migrateBefore: '_survey360_b' });
const ALL = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };

/** 按标签后缀取迁移 SQL 的各条语句（迁移重排编号后不用改测试）。 */
function statements(tagSuffix: string): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tag = journal.entries.find((e) => e.tag.endsWith(tagSuffix))!.tag;
  return readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** PR-A 结构上临时补出 PR-B 的列与表（取升级迁移本身的 SQL），前置步骤跑完即撤掉，等同 PR-A 历史数据。 */
async function withPrBSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const ddl = statements('_survey360_b');
  const tables = ddl.flatMap((s) => [...s.matchAll(/^CREATE TABLE "(\w+)"/g)].map((m) => m[1]!));
  const columns = ddl.flatMap((s) =>
    [...s.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g)].map((m) => [m[1]!, m[2]!]),
  );
  for (const statement of [...ddl, ...statements('_survey360_b_isolation')]) await db.execute(sql.raw(statement));
  try {
    return await run();
  } finally {
    await db.execute(sql.raw(`DROP TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`));
    for (const [table, column] of columns) await db.execute(sql.raw(`ALTER TABLE "${table}" DROP COLUMN "${column}"`));
  }
}

type Kind = 'content' | 'weights' | 'scoreMethod';

/** 已使用套卷的整卷内容（关键行为两层指标），可改角色权重或指标权重。 */
function contentOf(q: QuestionnaireView, roles: Record<string, number>, dims: Record<string, number>) {
  return {
    roles: q.roles.map((r) => ({ key: r.key, roleId: r.roleId, weight: roles[r.key] ?? r.weight })),
    scales: q.scales.map((sc) => ({ key: sc.key, name: sc.name, options: sc.options.map(({ id: _id, ...o }) => o) })),
    dimensions: q.dimensions.map((d) => ({
      key: d.key,
      parentKey: q.dimensions.find((x) => x.id === d.parentId)?.key ?? null,
      name: d.name,
      weight: dims[d.key] ?? d.weight,
    })),
    questions: q.questions.map((x) => ({
      key: x.key,
      dimensionKey: q.dimensions.find((d) => d.id === x.dimensionId)!.key,
      text: x.text,
      weight: 1,
      scaleKey: 's',
      ...(x.key === 'q1' ? { allowRemark: true } : {}),
    })),
  };
}

/** 等级评定套卷（单量表、无不计分选项）：加权平均与加权求和都可选，用来改计分方式。 */
async function ratingActivity(s: SceneB) {
  const { w } = s;
  const created = await w.ok<QuestionnaireView>(
    w.request('POST', '/questionnaires', {
      ifMatch: 0,
      body: { name: '升级等级评定', type: 'rating', scoreMethod: 'weighted_sum' },
    }),
    201,
  );
  const scale = { key: 'lv', name: '等级', options: [10, 20].map((v) => ({ key: `v${v}`, label: `${v}`, value: v })) };
  const q = await w.enableQuestionnaire(
    await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${created.id}`, {
        ifMatch: created.revision,
        body: {
          content: {
            roles: [
              { key: 'self', roleId: w.role('self'), weight: 0 },
              { key: 'superior', roleId: w.role('superior'), weight: 1 },
            ],
            scales: [scale],
            dimensions: [
              { key: 'c', name: '复合', weight: 100 },
              { key: 'b1', parentKey: 'c', name: '基础一', weight: 40, scaleKey: 'lv' },
              { key: 'b2', parentKey: 'c', name: '基础二', weight: 60, scaleKey: 'lv' },
            ],
            questions: [],
          },
        },
      }),
    ),
  );
  const activity = await w.activity({ name: '升级等级评定活动' });
  const object = await w.object(activity.id, s.person.T.id, [q.id]);
  const relation = await w.appraiser(activity.id, object.id, s.person.M.id, 'superior');
  await w.transition(activity.id, 'enable');
  const call = w.link(await w.token(activity.id, s.person.M.id));
  const option = (v: string) => q.scales[0]!.options.find((o) => o.key === v)!.id;
  const answers = ['b1', 'b2'].map((k, i) => ({
    itemId: q.dimensions.find((d) => d.key === k)!.id,
    optionId: option(i ? 'v10' : 'v20'),
  }));
  const task = `/tasks/${relation.id}/questionnaires/${q.id}`;
  const saved = await w.ok<{ revision: number }>(call('PUT', task, { ifMatch: 0, body: { answers } }));
  await w.ok(call('POST', `${task}/submit`, { ifMatch: saved.revision }));
  await w.transition(activity.id, 'disable');
  return { activityId: activity.id, qId: q.id };
}

/** 升级前：作答并停用计分（PR-A 计分批次）。返回改套卷计分口径的动作（round 区分两次改动的取值）。 */
async function legacy(db: Db, kind: Kind) {
  const s = await sceneB(db, `up-${kind}`);
  const { w } = s;
  let target = { activityId: s.activity.id, qId: s.q.id };
  if (kind === 'scoreMethod') target = await ratingActivity(s);
  else {
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4']);
    await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5']);
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4']);
    await w.transition(s.activity.id, 'disable');
  }
  const change = async (round: 1 | 2) => {
    const q = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${target.qId}`));
    const body =
      kind === 'scoreMethod'
        ? { scoreMethod: round === 1 ? 'weighted_average' : 'weighted_sum' }
        : kind === 'weights'
          ? { content: contentOf(q, { superior: round === 1 ? 9 : 7 }, {}) }
          : { content: contentOf(q, {}, round === 1 ? { b1: 70, b2: 30 } : { b1: 40, b2: 60 }) };
    await w.ok(w.request('PUT', `/questionnaires/${target.qId}`, { ifMatch: q.revision, body }));
  };
  return { s, kind, path: `/activities/${target.activityId}`, ...target, change };
}

type Legacy = Awaited<ReturnType<typeof legacy>>;

async function lastest360Cent(l: Legacy) {
  const port = await withTenant(l.s.w.db, l.s.w.tenantId, (tx) =>
    loadSurvey360Port(tx, { tenantId: l.s.w.tenantId, employeeIds: [l.s.employees.T.id], scope: ALL }),
  );
  return port.records(l.s.employees.T.id);
}

const reportRows = async (l: Legacy) =>
  (await l.s.w.ok<{ items: { id: string | null; status: string }[] }>(l.s.w.request('GET', `${l.path}/reports`))).items;

const generate = (l: Legacy) =>
  l.s.w.request('POST', `${l.path}/reports/generate`, { idempotencyKey: key(), body: {} });

async function expectDataChanged(res: Response, what: string) {
  expect(res.status, what).toBe(409);
  expect((await errorOf(res)).details?.reason, what).toBe('DATA_CHANGED');
}

it('PR-A 历史计分批次升级后：不能凭它生成报告；重新计分后改内容 / 权重 / 计分方式，各出口报告都失效', async () => {
  const handle = database();
  const scenes = await withPrBSchema(handle.db, async () => {
    const list: Legacy[] = [];
    for (const kind of ['content', 'weights', 'scoreMethod'] as const) list.push(await legacy(handle.db, kind));
    return list;
  });
  await handle.migrate();

  for (const l of scenes) {
    const { w } = l.s;
    // ① 历史批次没有版本基线：生成被拦（提示先启用 → 停用），改套卷前后都一样；列表没有有效报告、Lastest360Cent 不计入
    await expectDataChanged(await generate(l), `${l.kind} 历史批次生成`);
    expect((await errorOf(await generate(l))).message).toBe(DATA_CHANGED);
    await l.change(1);
    await expectDataChanged(await generate(l), `${l.kind} 改套卷后生成`);
    expect(
      (await reportRows(l)).every((r) => r.status !== 'generated'),
      l.kind,
    ).toBe(true);
    expect(await lastest360Cent(l), l.kind).toEqual({ ok: true, data: [] });

    // ② 启用 → 停用重新计分：批次记下版本，可以生成、转发，Lastest360Cent 计入
    w.setNow('2026-10-01T03:00:00Z');
    await w.transition(l.activityId, 'enable');
    await w.transition(l.activityId, 'disable');
    await w.ok(generate(l));
    const [row] = await reportRows(l);
    expect(row!.status, l.kind).toBe('generated');
    const others = [{ name: 'HRBP', email: `hrbp-up-${l.kind.toLowerCase()}@example.com` }];
    await w.ok(
      w.request('POST', `${l.path}/reports/forward`, { idempotencyKey: key(), body: { mode: 'others', others } }),
    );
    const [mail] = await outbox(w, 'survey360.report_forward');
    const link = reportLink(w, mail!.payload.token);
    await w.ok(link('GET', `/reports/${row!.id}`));
    const live = await lastest360Cent(l);
    expect(live.ok && live.data.length, l.kind).toBeGreaterThan(0);

    // ③ 再改已使用套卷：各出口一律按失效处理
    w.setNow('2026-10-01T06:00:00Z'); // 过了“2 小时一次”的限制，拦截只能来自计分口径变化
    await l.change(2);
    expect((await reportRows(l))[0]!.status, l.kind).toBe('outdated');
    await expectDataChanged(await w.request('GET', `${l.path}/reports/${row!.id}`), `${l.kind} 管理端查看`);
    await expectDataChanged(await link('GET', `/reports/${row!.id}`), `${l.kind} 收件人链接查看`);
    await expectDataChanged(await generate(l), `${l.kind} 更新报告`);
    // 转发预览 / 发送：失效的报告计入“无法转发”，不发邮件
    const forward = (path: string) =>
      w.ok<{ reportCount: number; unresolvedReports: number }>(
        w.request('POST', `${l.path}${path}`, { idempotencyKey: key(), body: { mode: 'others', others } }),
      );
    expect(await forward('/reports/forward/preview'), l.kind).toMatchObject({ reportCount: 0, unresolvedReports: 1 });
    expect(await forward('/reports/forward'), l.kind).toMatchObject({ reportCount: 0, unresolvedReports: 1 });
    expect(await outbox(w, 'survey360.report_forward'), l.kind).toHaveLength(1);
    expect(await lastest360Cent(l), l.kind).toEqual({ ok: true, data: [] });
  }
  // 三种改法各走一遍升级 + 报告全出口，负载高时超过默认 30 秒（第 4 轮审查首跑即超时）
}, 180_000);
