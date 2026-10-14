/**
 * AC-PRM-F075b（DEC-373①，审查逐项核实 18 项全部冗余）360 套卷模板 / 报告模板 9 个入口：loadAdmin 预取的 Activity
 * 查看权与“全部活动”按钮，不影响这 9 个入口的返回：
 *   GET / POST `/questionnaire-templates`、GET / PUT / DELETE `/questionnaire-templates/:id`、
 *   POST `/questionnaire-templates/:id/instantiate`、POST `/questionnaires/:id/save-as-template`、
 *   GET / PUT `/report-template`。
 * 本文件在**改动前的代码上生成黄金文件并提交**，改动后原样保持全绿（黄金文件不得重生成覆盖）：
 *   - 每个入口比较状态码、ETag、完整正文（含错误 message / details）；只规范化生成 ID 与 createdAt / updatedAt；
 *   - 原生授权（真实 360 权限）：系统 / 高级 / 一般管理员与无身份成员，精细化权限关 / 开；
 *   - 全允许替身：Activity 查看 / viewAll 两个键的四种答案组合，转录相同；
 *   - 自建身份（真实授权器）：只授 Questionnaire / Settings（完全不授 Activity）、Activity 全字段隐藏、套卷 / 设置字段隐藏、
 *     缺 editOthers 的操作人——与“同样的 Questionnaire / Settings 授权 + 完整 Activity 授权”的转录逐字节相同（独立性）。
 * 保留的有效授权（Questionnaire / Settings 的操作、按钮、字段、editOthers）由负例场景覆盖：撤掉它们返回照常被拒。
 */
import type { Db } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, type World360, world360 } from './AC-360-support.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import { expectGolden, expectSameTranscript, step, type Step } from './support/f075-equivalence.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const NEW_ID = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';
const TEMPLATES = '/questionnaire-templates';
const REPORT_TEMPLATE = '/report-template';
/** 被去掉的两个冗余请求键（18 项都是这一对）。 */
const REDUNDANT_KEYS = ['obj:Survey360.Activity:view', 'btn:Survey360.Activity#viewAll@list'] as const;

type Send = (user: string) => (method: string, path: string, opts?: RequestOptions) => Promise<Response>;
interface Created {
  readonly id: string;
  readonly revision: number;
}

/** 固定场景：9 个入口 × 成功 / 非法 / 冲突 / 不存在 / 类型错误 / 重放，本人与他人的模板，普通套卷与模板互相隔离。 */
async function scenario(w: World360, send: Send, actor: string, label: string): Promise<Step[]> {
  const steps: Step[] = [];
  const admin = send(w.admin);
  const json = async <T>(res: Promise<Response>) => (await (await res).json()) as T;
  const rev = async (path: string) => (await json<{ revision: number }>(admin('GET', path))).revision;
  const run = async (name: string, method: string, path: string, opts: RequestOptions = {}) =>
    steps.push(await step(`${label} ${name}`, await send(actor)(method, path, opts)));
  /** 记录并返回创建结果（失败时 undefined）。 */
  const create = async (name: string, path: string, body: unknown, opts: RequestOptions = {}) => {
    const res = await send(actor)('POST', path, { ifMatch: 0, body, ...opts });
    steps.push(await step(`${label} ${name}`, res.clone()));
    return res.status === 201 ? ((await res.json()) as Created) : undefined;
  };

  // 管理员预置：普通套卷（带内容）与他人的模板（带内容）
  const content = w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 });
  const makeAs = async (path: string, name: string) => {
    const made = await json<Created>(admin('POST', path, { ifMatch: 0, body: { name, type: 'key_behavior' } }));
    await admin('PUT', `${path}/${made.id}`, { ifMatch: made.revision, body: { content } });
    return made;
  };
  const ordinary = await makeAs('/questionnaires', '普通套卷');
  const others = await makeAs(TEMPLATES, '他人模板');

  // ---- GET / POST /questionnaire-templates ----
  await run('GET 模板列表', 'GET', TEMPLATES);
  const mine = await create('POST 模板', TEMPLATES, { name: '本人模板', type: 'key_behavior' });
  await create(
    'POST 模板 重放同键同内容',
    TEMPLATES,
    { name: '重放模板', type: 'key_behavior' },
    { idempotencyKey: 'k-r' },
  );
  await create('POST 模板 重放', TEMPLATES, { name: '重放模板', type: 'key_behavior' }, { idempotencyKey: 'k-r' });
  await create('POST 模板 同键异内容', TEMPLATES, { name: '另一个', type: 'key_behavior' }, { idempotencyKey: 'k-r' });
  await create('POST 模板 非法体', TEMPLATES, {});
  await create('POST 模板 非 0 revision', TEMPLATES, { name: 'x', type: 'key_behavior' }, { ifMatch: 3 });
  await run('GET 模板列表 之后', 'GET', TEMPLATES);

  // ---- GET /questionnaire-templates/:id ----
  if (mine) await run('GET 模板详情 本人', 'GET', `${TEMPLATES}/${mine.id}`);
  await run('GET 模板详情 他人', 'GET', `${TEMPLATES}/${others.id}`);
  await run('GET 模板详情 普通套卷 ID', 'GET', `${TEMPLATES}/${ordinary.id}`);
  await run('GET 模板详情 不存在', 'GET', `${TEMPLATES}/${NEW_ID}`);
  await run('GET 模板详情 非法标识', 'GET', `${TEMPLATES}/not-a-uuid`);

  // ---- PUT /questionnaire-templates/:id ----
  if (mine) {
    const path = `${TEMPLATES}/${mine.id}`;
    await run('PUT 模板 本人整卷', 'PUT', path, { ifMatch: mine.revision, body: { name: '本人模板改', content } });
    await run('PUT 模板 本人过期', 'PUT', path, { ifMatch: mine.revision, body: { name: '再改' } });
    await run('PUT 模板 本人非法体', 'PUT', path, { ifMatch: await rev(path), body: { name: '' } });
    await run('PUT 模板 本人重放', 'PUT', path, {
      ifMatch: await rev(path),
      body: { name: '重放改名' },
      idempotencyKey: 'k-put',
    });
    await run('PUT 模板 本人重放 再发', 'PUT', path, {
      ifMatch: await rev(path),
      body: { name: '重放改名' },
      idempotencyKey: 'k-put',
    });
  }
  await run('PUT 模板 他人', 'PUT', `${TEMPLATES}/${others.id}`, {
    ifMatch: await rev(`${TEMPLATES}/${others.id}`),
    body: { name: '他人模板被改' },
  });
  await run('PUT 模板 普通套卷 ID', 'PUT', `${TEMPLATES}/${ordinary.id}`, {
    ifMatch: await rev(`/questionnaires/${ordinary.id}`),
    body: { name: '类型错误' },
  });
  await run('PUT 模板 不存在', 'PUT', `${TEMPLATES}/${NEW_ID}`, { ifMatch: 0, body: { name: 'x' } });
  await run('PUT 模板 非法标识', 'PUT', `${TEMPLATES}/not-a-uuid`, { ifMatch: 0, body: { name: 'x' } });

  // ---- POST instantiate / save-as-template（先于删除：复制自他人模板与普通套卷）----
  const copy = await create('POST instantiate', `${TEMPLATES}/${others.id}/instantiate`, { name: '实例化副本' });
  await create(
    'POST instantiate 重放',
    `${TEMPLATES}/${others.id}/instantiate`,
    { name: '重放副本' },
    { idempotencyKey: 'k-i', ifMatch: 0 },
  );
  await create(
    'POST instantiate 重放 再发',
    `${TEMPLATES}/${others.id}/instantiate`,
    { name: '重放副本' },
    { idempotencyKey: 'k-i' },
  );
  await create('POST instantiate 非法体', `${TEMPLATES}/${others.id}/instantiate`, {});
  await create('POST instantiate 普通套卷 ID', `${TEMPLATES}/${ordinary.id}/instantiate`, { name: 'x' });
  await create('POST instantiate 不存在', `${TEMPLATES}/${NEW_ID}/instantiate`, { name: 'x' });
  const saved = await create('POST save-as-template', `/questionnaires/${ordinary.id}/save-as-template`, {
    name: '另存模板',
  });
  await create(
    'POST save-as-template 重放',
    `/questionnaires/${ordinary.id}/save-as-template`,
    { name: '重放另存' },
    { idempotencyKey: 'k-s' },
  );
  await create(
    'POST save-as-template 重放 再发',
    `/questionnaires/${ordinary.id}/save-as-template`,
    { name: '重放另存' },
    { idempotencyKey: 'k-s' },
  );
  await create('POST save-as-template 模板 ID', `/questionnaires/${others.id}/save-as-template`, { name: 'x' });
  await create('POST save-as-template 不存在', `/questionnaires/${NEW_ID}/save-as-template`, { name: 'x' });
  await create('POST save-as-template 非法体', `/questionnaires/${ordinary.id}/save-as-template`, {});
  // 复制是独立的：改源之后副本不变（管理员读取，不属于被测操作人）
  if (copy) steps.push(await step(`${label} 副本读取`, await admin('GET', `/questionnaires/${copy.id}`)));
  if (saved) steps.push(await step(`${label} 另存读取`, await admin('GET', `${TEMPLATES}/${saved.id}`)));
  await admin('PUT', `${TEMPLATES}/${others.id}`, {
    ifMatch: await rev(`${TEMPLATES}/${others.id}`),
    body: { name: '源已改' },
  });
  if (copy) steps.push(await step(`${label} 副本读取 源改动后`, await admin('GET', `/questionnaires/${copy.id}`)));

  // ---- DELETE /questionnaire-templates/:id ----
  const doomed = await create('POST 模板 待删甲', TEMPLATES, { name: '待删甲', type: 'key_behavior' });
  if (doomed) {
    await run('DELETE 模板 本人过期', 'DELETE', `${TEMPLATES}/${doomed.id}`, { ifMatch: 9 });
    const path = `${TEMPLATES}/${doomed.id}`;
    await run('DELETE 模板 本人', 'DELETE', path, { ifMatch: await rev(path), idempotencyKey: 'k-d' });
    await run('DELETE 模板 本人重放', 'DELETE', path, { ifMatch: 1, idempotencyKey: 'k-d' });
    await run('DELETE 模板 本人已删除再删', 'DELETE', path, { ifMatch: 1 });
    await run('GET 模板详情 已删除', 'GET', path);
  }
  await run('DELETE 模板 他人', 'DELETE', `${TEMPLATES}/${others.id}`, {
    ifMatch: await rev(`${TEMPLATES}/${others.id}`),
  });
  await run('DELETE 模板 普通套卷 ID', 'DELETE', `${TEMPLATES}/${ordinary.id}`, {
    ifMatch: await rev(`/questionnaires/${ordinary.id}`),
  });
  await run('DELETE 模板 不存在', 'DELETE', `${TEMPLATES}/${NEW_ID}`, { ifMatch: 0 });
  await run('GET 模板列表 最后', 'GET', TEMPLATES);

  // ---- GET / PUT /report-template ----
  await run('GET 报告模板', 'GET', REPORT_TEMPLATE);
  const current = await rev(REPORT_TEMPLATE);
  await run('PUT 报告模板', 'PUT', REPORT_TEMPLATE, {
    ifMatch: current,
    body: { name: '标准报告模板改', showTextRole: true },
  });
  await run('PUT 报告模板 过期', 'PUT', REPORT_TEMPLATE, { ifMatch: current, body: { name: '再改' } });
  await run('PUT 报告模板 非法体', 'PUT', REPORT_TEMPLATE, { ifMatch: await rev(REPORT_TEMPLATE), body: { name: '' } });
  await run('PUT 报告模板 多余字段', 'PUT', REPORT_TEMPLATE, {
    ifMatch: await rev(REPORT_TEMPLATE),
    body: { extra: 1 },
  });
  await run('PUT 报告模板 重放', 'PUT', REPORT_TEMPLATE, {
    ifMatch: await rev(REPORT_TEMPLATE),
    body: { showTextRole: false },
    idempotencyKey: 'k-rt',
  });
  await run('PUT 报告模板 同键异内容', 'PUT', REPORT_TEMPLATE, {
    ifMatch: await rev(REPORT_TEMPLATE),
    body: { showTextRole: true },
    idempotencyKey: 'k-rt',
  });
  await run('GET 报告模板 之后', 'GET', REPORT_TEMPLATE);
  return steps;
}

const asUser =
  (w: World360): Send =>
  (user) =>
  (method, path, opts) =>
    w.as(user)(method, path, opts);

/** 自建身份的对象授权：全部字段可见 / 可编辑（system 字段只读）、全部数据操作，可隐藏字段、去掉按钮。 */
function grantObject(
  key: keyof typeof survey360.SURVEY360_OBJECTS,
  options: { hide?: readonly string[]; withoutButtons?: readonly string[]; hideAll?: boolean } = {},
) {
  const definition = survey360.SURVEY360_OBJECTS[key];
  const hidden = new Set(options.hide ?? []);
  return {
    objectCode: definition.code,
    dataOperations: {
      create: definition.buttons.some((b) => b.requires === 'create'),
      update: definition.buttons.some((b) => b.requires === 'update'),
      delete: definition.buttons.some((b) => b.requires === 'delete'),
    },
    fields: definition.fields.map((f) => ({
      fieldCode: f.code,
      view: !options.hideAll && !hidden.has(f.code),
      edit: !f.system && !options.hideAll && !hidden.has(f.code),
    })),
    buttons: definition.buttons
      .filter((b) => !(options.withoutButtons ?? []).includes(b.code))
      .map((b) => ({ buttonCode: b.code, level: b.level })),
  };
}

type Variant = (w: World360) => ReturnType<typeof grantObject>[];
const QS = () => [grantObject('questionnaire'), grantObject('settings')];
const VARIANTS: Record<string, { objects: Variant; golden?: string }> = {
  /** 基准：Questionnaire / Settings + 完整的 Activity 授权。 */
  'q+s+activity': { objects: () => [...QS(), grantObject('activity')], golden: 'f075b-custom-full' },
  /** 只授 Questionnaire / Settings，完全不授 Activity。 */
  'q+s 无 activity': { objects: QS, golden: 'f075b-custom-no-activity' },
  /** Activity 授权在，但全部字段隐藏。 */
  'activity 全字段隐藏': {
    objects: () => [...QS(), grantObject('activity', { hideAll: true })],
    golden: 'f075b-custom-activity-hidden',
  },
  /** 套卷 / 设置的部分字段隐藏。 */
  'q / s 字段隐藏': {
    objects: () => [
      grantObject('questionnaire', { hide: ['name', 'createdBy', 'guide'] }),
      grantObject('settings', { hide: ['name', 'showTextRole'] }),
      grantObject('activity'),
    ],
    golden: 'f075b-custom-fields-hidden',
  },
  /** 缺 editOthers：改 / 删他人模板被拒（保留的有效授权）。 */
  'q+s 无 editOthers': {
    objects: () => [
      grantObject('questionnaire', { withoutButtons: [survey360.SURVEY360_BUTTONS.editOthers] }),
      grantObject('settings'),
    ],
    golden: 'f075b-custom-no-editothers',
  },
  /** 缺 Questionnaire 创建 / 更新 / 删除按钮与 Settings 更新按钮：被拒不变。 */
  'q+s 缺写按钮': {
    objects: () => [
      grantObject('questionnaire', { withoutButtons: ['create', 'update', 'delete'] }),
      grantObject('settings', { withoutButtons: ['update'] }),
      grantObject('activity'),
    ],
    golden: 'f075b-custom-no-write-buttons',
  },
};

describe('AC-PRM-F075b 360 套卷模板 / 报告模板：去掉 loadAdmin 预取前后返回完全一致（DEC-373①）', () => {
  it('原生授权（精细化关）：系统 / 高级 / 一般管理员与无身份成员，转录与改动前的黄金文件逐字节相等', async () => {
    const run = async (kind: 'advanced' | 'general' | 'plain' | 'system') => {
      const w = await world360(testDb().db as Db, `f075b${kind}`);
      const user = kind === 'system' ? w.admin : await w.member(`f075b-${kind}`);
      if (kind === 'advanced' || kind === 'general') await w.appoint(user, kind);
      return scenario(w, asUser(w), user, kind);
    };
    const steps = [
      ...(await run('system')),
      ...(await run('advanced')),
      ...(await run('general')),
      ...(await run('plain')),
    ];
    expect(steps.length).toBeGreaterThan(150);
    expectGolden('f075b-native', steps);
  }, 600_000);

  it('原生授权（精细化开）：系统 / 高级 / 一般管理员的转录与改动前的黄金文件逐字节相等', async () => {
    const run = async (kind: 'advanced' | 'general' | 'system') => {
      const w = await world360(testDb().db as Db, `f075bfine${kind}`);
      const settings = await (await w.request('GET', '/settings')).json();
      await w.ok(
        w.request('PUT', '/settings', {
          ifMatch: (settings as { revision: number }).revision,
          body: { finePermission: true },
        }),
      );
      const user = kind === 'system' ? w.admin : await w.member(`f075bfine-${kind}`);
      if (kind !== 'system') await w.appoint(user, kind);
      return scenario(w, asUser(w), user, kind);
    };
    const steps = [...(await run('system')), ...(await run('advanced')), ...(await run('general'))];
    expectGolden('f075b-native-fine', steps);
  }, 600_000);

  it('全允许替身：Activity 查看 / viewAll 两个键的四种答案组合，转录都相同，也等于黄金文件', async () => {
    const run = async (label: string, revoke: readonly string[]) => {
      const w = await world360(testDb().db as Db, label);
      const double = createAuthorizerDouble();
      for (const key of revoke) double.revoke(key);
      const api = tenantApi(testDb().db as Db, {
        clock: () => new Date('2026-10-01T01:00:00Z'),
        authorize: double.authorize,
      });
      const send: Send =
        (user) =>
        (method, path, opts = {}) =>
          api.request(method, `${BASE}${path}`, { ...opts, user, tenant: w.tenantId });
      return scenario(w, send, w.admin, 'double');
    };
    const allowed = await run('f075ballow', []);
    expect(allowed.filter((s) => s.status === 200 || s.status === 201).length).toBeGreaterThan(20);
    const [view, viewAll] = REDUNDANT_KEYS;
    const combinations: readonly (readonly [string, readonly string[]])[] = [
      ['只撤 Activity:view', [view]],
      ['只撤 viewAll 按钮', [viewAll]],
      ['两个一起撤', [view, viewAll]],
    ];
    for (const [label, keys] of combinations)
      expectSameTranscript(await run(`f075b${keys.length}${keys[0] === viewAll ? 'b' : 'a'}`, keys), allowed, label);
    expectGolden('f075b-all-allow', allowed);
  }, 600_000);

  const variant = async (name: string) => {
    const w = await world360(testDb().db as Db, 'f075bvariant');
    const user = await w.member('f075b-operator');
    const profile = await w.defineProfile(name, VARIANTS[name]!.objects(w));
    await w.grantProfile(user, profile);
    return scenario(w, asUser(w), user, 'op');
  };

  it.each(Object.keys(VARIANTS))(
    '自建身份（真实授权器）：%s——转录等于改动前的黄金文件',
    async (name) => {
      const steps = await variant(name);
      expect(steps.length).toBeGreaterThan(35);
      expectGolden(VARIANTS[name]!.golden!, steps);
    },
    300_000,
  );

  it('独立性：完全不授 Activity / Activity 全字段隐藏的操作人，与同样 Questionnaire / Settings 授权 + 完整 Activity 授权的操作人返回相同', async () => {
    const base = await variant('q+s+activity');
    expectSameTranscript(await variant('q+s 无 activity'), base, '不授 Activity');
    expectSameTranscript(await variant('activity 全字段隐藏'), base, 'Activity 全字段隐藏');
  }, 600_000);

  it('保留的有效授权：缺 editOthers 改 / 删他人模板被拒；缺写按钮的写入被拒（负例确实触发）', async () => {
    const without = await variant('q+s 无 editOthers');
    const fine = await variant('q+s+activity');
    const named = (steps: Step[], name: string) => steps.find((s) => s.name === `op ${name}`)!;
    for (const name of ['PUT 模板 他人', 'DELETE 模板 他人']) {
      expect(named(fine, name).status, `${name} 有 editOthers`).toBe(200);
      expect(named(without, name).status, `${name} 缺 editOthers`).toBe(403);
    }
    const noWrite = await variant('q+s 缺写按钮');
    for (const name of ['POST 模板', 'POST instantiate', 'POST save-as-template']) {
      expect(named(fine, name).status, name).toBe(201);
      expect(named(noWrite, name).status, `${name} 缺创建按钮`).toBe(403);
    }
    expect(named(noWrite, 'PUT 报告模板').status).toBe(403);
    expect(named(fine, 'PUT 报告模板').status).toBe(200);
  }, 600_000);
});
