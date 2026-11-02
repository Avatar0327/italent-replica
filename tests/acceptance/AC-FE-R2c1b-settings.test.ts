/**
 * FE-R2c1b 试用设置页：冒烟夹具与解析器按真实接口核对（夹具照后端形态，不手写前端类型）。
 *   - 试用结果字典：GET 预置项、POST / PUT 整行回执、编码重复 409；
 *   - 自动转正（B57）/ 自动发起考核（B58）规则：整条视图键集、新增 / 编辑 / 复制 / 启停 / 删除回执、立即执行回执与关闭时的拒绝；
 *   - 两层配置：总开关与并行规则（B59）的回显与 PUT 回执；
 *   - 写能力：真实管理员的对象权限 + 快照菜单下可写，普通成员读写都被拒、页面不可写。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  COPY_SUFFIX,
  PARALLEL_KEYS,
  SWITCH_KEYS,
  assessmentRule,
  otherSettingsMenu,
  parallelDefault,
  regularizationRule,
  resultCodeTaken,
  resultPresets,
  revisionConflict,
  runDisabled,
  runReceipt,
  setting,
  settingsPermission,
} from '../../apps/web/smoke/probation-settings-fixtures.js';
import type { MenuNode } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  RESULTS_PATH,
  RULES,
  SETTINGS_OBJECT,
  isSwitchValue,
  parallelBody,
  parallelValid,
  parseDeleteReceipt,
  parseResultReceipt,
  parseResults,
  parseRuleReceipt,
  parseRules,
  parseRunReceipt,
  parseSetting,
  parseSettingReceipt,
  resultAccess,
  ruleAccess,
  ruleBody,
  ruleValues,
  settingPath,
  settingWritable,
  type RuleKind,
} from '../../apps/web/src/probation/settings-model.js';
import { exitWorld } from './AC-EXIT-support.js';
import { autoAssessmentWorld } from './AC-PB-BE15b2-support.js';
import { hire, pbWorld } from './AC-PB-support.js';
import { addMember } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const ROOT = '/api/tenant/employment';
const keysOf = (value: object) => Object.keys(value).sort();

async function world(label: string) {
  const w = await pbWorld(testDb().db, `fe-r2c1b-${label}-${randomUUID()}`, { approval: true });
  const api = tenantApi(w.db);
  const as = { tenant: w.session.tenant.id, user: w.session.user.id };
  const call = (method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, path, { ...as, body, ifMatch, idempotencyKey: randomUUID() });
  const json = async (response: Response, status: number) => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as Record<string, unknown>;
  };
  return { ...w, call, json };
}
type World = Awaited<ReturnType<typeof world>>;

const ruleInput = (w: World, kind: RuleKind) =>
  ruleValues(
    kind,
    kind === 'regularization'
      ? regularizationRule({ orgIds: [w.org.id], mode: 'direct' })
      : assessmentRule({ orgIds: [w.org.id], daysAfterEntry: 1 }),
  );

describe('AC-FE-R2c1b 试用结果字典：夹具与真实接口一致', () => {
  it('GET 预置三项与夹具同形；POST / PUT 回执整行、版本 + 1；编码重复（不分大小写）409', async () => {
    const w = await world('results');
    expect(RESULTS_PATH).toBe(`${ROOT}/probation-results`);
    const listed = await w.json(await w.call('GET', RESULTS_PATH), 200);
    const rows = parseResults(listed);
    const presets = resultPresets();
    expect(rows.map(keysOf)).toEqual(presets.map(keysOf));
    expect(rows.map(({ id: _id, ...row }) => row)).toEqual(presets.map(({ id: _id, ...row }) => row));

    const created = await w.json(
      await w.call('POST', RESULTS_PATH, { code: 'zz_pass', name: 'ZZ_合成通过', enabled: true, displayOrder: 40 }, 0),
      201,
    );
    expect(keysOf(created)).toEqual(keysOf(presets[0]!));
    const { id } = parseResultReceipt(created, { revision: 0 });
    const renamed = await w.json(await w.call('PUT', `${RESULTS_PATH}/${id}`, { name: 'ZZ_改名' }, 1), 200);
    expect(parseResultReceipt(renamed, { id, revision: 1 })).toEqual({ id });
    expect(() => parseResultReceipt(renamed, { id, revision: 0 })).toThrow();

    const taken = await w.call('POST', RESULTS_PATH, { code: 'ZZ_PASS', name: 'ZZ_重复' }, 0);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject(resultCodeTaken);
    const stale = await w.call('PUT', `${RESULTS_PATH}/${id}`, { enabled: false }, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: revisionConflict.error.code } });
  });
});

describe.each(['regularization', 'assessment'] as const)('AC-FE-R2c1b %s 规则：夹具与真实接口一致', (kind) => {
  const fixture = kind === 'regularization' ? regularizationRule : assessmentRule;
  it('新增 / 编辑（整份）/ 复制 / 启停 / 删除回执与夹具同形，版本按提交版本 + 1', async () => {
    const w = await world(`${kind}-crud`);
    const path = RULES[kind].path;
    const created = await w.json(await w.call('POST', path, ruleInput(w, kind), 0), 201);
    expect(keysOf(created)).toEqual(keysOf(fixture()));
    const { id } = parseRuleReceipt(created, { revision: 0 });
    expect(parseRules(await w.json(await w.call('GET', path), 200)).map(keysOf)).toEqual([keysOf(fixture())]);

    const body = ruleBody(kind, ruleValues(kind, created), { name: 'ZZ_改名', priority: 3 });
    expect(keysOf(body)).toEqual([...RULES[kind].fields].sort());
    const edited = await w.json(await w.call('PUT', `${path}/${id}`, body, 1), 200);
    expect(edited).toMatchObject({ name: 'ZZ_改名', priority: 3, enabled: true, revision: 2 });
    expect(parseRuleReceipt(edited, { id, revision: 1 })).toEqual({ id });

    const copied = await w.json(await w.call('POST', `${path}/${id}/copy`, {}, 0), 201);
    expect(copied).toMatchObject({ name: `ZZ_改名${COPY_SUFFIX}`, enabled: false, revision: 1 });
    const copy = parseRuleReceipt(copied, { revision: 0 }).id;
    expect(copy).not.toBe(id);

    const toggled = await w.json(await w.call('PUT', `${path}/${id}/enabled`, { enabled: false }, 2), 200);
    expect(toggled).toMatchObject({ enabled: false, revision: 3 });
    expect(parseRuleReceipt(toggled, { id, revision: 2 })).toEqual({ id });
    const stale = await w.call('PUT', `${path}/${id}/enabled`, { enabled: true }, 2);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: revisionConflict.error.code } });

    const removed = await w.json(await w.call('DELETE', `${path}/${copy}`, undefined, 1), 200);
    expect(removed).toEqual({ id: copy, deleted: true });
    expect(parseDeleteReceipt(removed, copy)).toEqual({ id: copy });
    expect(parseRules(await w.json(await w.call('GET', path), 200)).map((rule) => rule.id)).toEqual([id]);
  });
});

/** 立即执行：开关关闭 → 409 reason；开关打开 → 回执键集与夹具一致并能解析。 */
async function checkRun(
  kind: RuleKind,
  run: () => Promise<Response>,
  employeeId: string,
  switchOn: () => Promise<void>,
) {
  const closed = await run();
  expect(closed.status).toBe(409);
  expect(await closed.json()).toMatchObject(runDisabled[kind]);
  await switchOn();
  const response = await run();
  expect(response.status, await response.clone().text()).toBe(200);
  const receipt = (await response.json()) as Record<string, unknown>;
  const sample = runReceipt[kind](employeeId, 'rule');
  expect(keysOf(receipt)).toEqual(keysOf(sample));
  expect((receipt.launched as Record<string, unknown>[]).map(keysOf)).toEqual(sample.launched.map(keysOf));
  const parsed = parseRunReceipt(kind, receipt);
  expect(parsed.launched.map((item) => item.employeeId)).toEqual([employeeId]);
  expect(parsed.nextCursor).toBeNull();
}

describe('AC-FE-R2c1b 立即执行与总开关：夹具与真实接口一致', () => {
  it('自动转正：开关默认关、PUT 回执版本 + 1；关闭时立即执行 409，打开后回执与夹具同形', async () => {
    const w = await world('regularization-run');
    const key = RULES.regularization.setting;
    expect(key).toBe(SWITCH_KEYS.regularization);
    const off = await w.json(await w.call('GET', settingPath(key)), 200);
    expect(off).toEqual(setting(key, false));
    expect(parseSetting(off, key, isSwitchValue)).toEqual(off);
    await w.json(await w.call('POST', RULES.regularization.path, ruleInput(w, 'regularization'), 0), 201);
    // 试用期 09-01～09-30：到期前 0 天，今天 10-01 已到期（补发，AC-PB-07）
    const due = await hire(w, { date: '2026-09-01', months: 1, name: 'ZZ_到期员工' });
    const run = () => w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    await checkRun('regularization', run, due.employee.id, async () => {
      const on = await w.json(await w.call('PUT', settingPath(key), { value: true }, 0), 200);
      expect(on).toEqual(setting(key, true, 1));
      expect(parseSettingReceipt(on, key, isSwitchValue, 0)).toEqual({ id: key });
      expect(() => parseSettingReceipt(on, key, isSwitchValue, 1)).toThrow();
    });
  });

  it('自动发起考核：开关默认关；关闭时立即执行 409，打开后回执与夹具同形', async () => {
    const w = await autoAssessmentWorld(testDb().db, `fe-r2c1b-${randomUUID()}`);
    const key = RULES.assessment.setting;
    expect(key).toBe(SWITCH_KEYS.assessment);
    expect(RULES.assessment.run).toBe(`${ROOT}/auto-assessment/run`);
    const off = await w.json<Record<string, unknown>>(await w.request(w.hr.id, 'GET', settingPath(key)));
    expect(parseSetting(off, key, isSwitchValue)).toEqual(setting(key, false));
    // 入职 09-01、今天 10-01 是第 30 天：规则 N=30 当天命中（AC-PB-06）
    const person = await w.probationer('ZZ_第三十天员工');
    await w.created(w.body());
    await checkRun(
      'assessment',
      () => w.runNow(),
      person.employeeId,
      () => w.enableSwitch(),
    );
  });
});

describe('AC-FE-R2c1b 并行规则（B59）：夹具与真实接口一致', () => {
  it('两项默认关；PUT 整份 { enabled, allowed }，关闭时 allowed 提交 []；非候选值被拒', async () => {
    const w = await world('parallel');
    for (const [blocker, key] of Object.entries(PARALLEL_KEYS)) {
      const valid = parallelValid(blocker as keyof typeof PARALLEL_KEYS);
      const read = await w.json(await w.call('GET', settingPath(key)), 200);
      expect(read).toEqual(setting(key, parallelDefault));
      expect(parseSetting(read, key, valid)).toEqual(read);
    }
    const key = PARALLEL_KEYS.regularization_assessment;
    const valid = parallelValid('regularization_assessment');
    const on = parallelBody('regularization_assessment', parallelDefault, {
      enabled: true,
      allowed: ['regularization'],
    });
    const saved = await w.json(await w.call('PUT', settingPath(key), { value: on }, 0), 200);
    expect(saved).toEqual(setting(key, { enabled: true, allowed: ['regularization'] }, 1));
    expect(parseSettingReceipt(saved, key, valid, 0)).toEqual({ id: key });
    const off = parallelBody('regularization_assessment', on, { enabled: false });
    expect(off).toEqual({ enabled: false, allowed: [] });
    expect(await w.json(await w.call('PUT', settingPath(key), { value: off }, 1), 200)).toEqual(setting(key, off, 2));
    const bad = await w.call(
      'PUT',
      settingPath(key),
      { value: { enabled: true, allowed: ['probation_assessment'] } },
      2,
    );
    expect(bad.status).toBe(400);
  });
});

describe('AC-FE-R2c1b 写能力按真实管理员 / 普通成员', () => {
  /** 与 settings/pages.ts 的 children 相同：企业设置下一层是 adminMenus，editable 原样带下去。 */
  const menusOf = (adminMenus: { code: string; editable: boolean }[]): MenuNode[] => [
    {
      key: 'settings',
      label: '企业设置',
      path: '/settings',
      group: 'settings',
      children: adminMenus.map((menu) => ({
        key: menu.code,
        label: menu.code,
        path: '',
        group: 'settings',
        editable: menu.editable,
      })),
    },
  ];
  it('管理员可写全部入口；普通成员读规则 / 配置都 403，各入口不可写', async () => {
    const w = await exitWorld(testDb().db, `fe-r2c1b-perm-${randomUUID()}`);
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-30T01:00:00Z') });
    const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
    const asAdmin = { tenant: w.tenant.id, user: w.user.id };
    const member = await addMember({ db: w.db, tenant: w.tenant, admin: w.user, adminRecord, api, asAdmin }, 'ZZ_成员');
    const as = (user: string, method: string, path: string) => api.request(method, path, { tenant: w.tenant.id, user });
    const objectPath = `/api/tenant/permission/me/objects/${encodeURIComponent(SETTINGS_OBJECT)}`;
    const snapshotPath = '/api/tenant/permission/me/snapshot';

    const snapshot = await (await as(w.user.id, 'GET', snapshotPath)).json();
    expect(snapshot.adminMenus).toContainEqual(otherSettingsMenu);
    const permission = await (await as(w.user.id, 'GET', objectPath)).json();
    expect(permission).toEqual(settingsPermission);
    const menus = menusOf(snapshot.adminMenus);
    expect(resultAccess(permission, menus)).toEqual({
      create: true,
      createFields: ['code', 'name', 'enabled', 'displayOrder'],
      updateFields: ['name', 'enabled', 'displayOrder'],
    });
    for (const kind of ['regularization', 'assessment'] as const)
      expect(ruleAccess(kind, permission, menus)).toEqual({
        create: true,
        update: true,
        copy: true,
        toggle: true,
        remove: true,
        run: true,
      });
    const switchRead = parseSetting(
      await (await as(w.user.id, 'GET', settingPath(SWITCH_KEYS.regularization))).json(),
      SWITCH_KEYS.regularization,
      isSwitchValue,
    );
    expect(settingWritable(permission, menus, switchRead)).toBe(true);

    const memberSnapshot = await (await as(member.id, 'GET', snapshotPath)).json();
    const memberMenus = menusOf(memberSnapshot.adminMenus);
    expect((await as(member.id, 'GET', objectPath)).status).toBe(403);
    for (const path of [
      RULES.regularization.path,
      RULES.assessment.path,
      settingPath(PARALLEL_KEYS.probation_assessment),
    ])
      expect((await as(member.id, 'GET', path)).status, path).toBe(403);
    expect(resultAccess(undefined, memberMenus).create).toBe(false);
    expect(Object.values(ruleAccess('regularization', undefined, memberMenus)).some(Boolean)).toBe(false);
    expect(settingWritable(undefined, memberMenus, { overridable: true })).toBe(false);
  });
});
