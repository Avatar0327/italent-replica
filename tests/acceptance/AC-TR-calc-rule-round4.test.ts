/**
 * AC-TR-calc-rule-round4 · PR #184 第 3 轮审查的 P2 回归（每项先失败；DEC-274 提示按查看人裁剪）：
 * - P2-08a：提示裁剪按完整字段路径判断可见性，不做文本子串匹配——看不到的字段名是可见字段名的前缀（“绩效” / “绩效得分”）时，
 *   完全可见的循环路径与类型不确定提示不能被误删；
 * - P2-08b：提示的类别（循环 / 类型不确定 / 优先级矛盾…）来自结构化诊断，不从含字段名的文案推断——字段名里含“循环”“成环”
 *   “依赖”等诊断关键词时，被裁掉的非循环提示不能变成“存在循环依赖”。
 * 受控授权：功能权限全开；字段目录范围 = 只看自己建的（创建人范围），把某些字段的创建人清空即对查看人不可见。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { inArray, talentReviewFields, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { CALC_RULES, calcBody, calcItem, calcWorld, type CalcRuleView, pathOf } from './AC-TR-calc-rule-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { tenantApi } from './support/tenant-api.js';
import './support/b5-path.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const SEE_ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
const TYPE_UNCERTAIN = 'Year(IF(真,Today(),1))';

/** 一个租户 + 受控授权的请求入口：字段目录范围可在“看全部”与“创建人范围”之间切换。 */
async function world(label: string) {
  const w = await calcWorld(testDb().db, `${label}-${randomUUID().slice(0, 4)}`);
  let fieldScope: ModuleScope = SEE_ALL;
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => (query.objectCode === TALENT_REVIEW_OBJECTS.field.code ? fieldScope : SEE_ALL),
    authorize: async () => true,
    fields: async (_tenant, _user, code) =>
      new Set(
        Object.values(TALENT_REVIEW_OBJECTS)
          .find((item) => item.code === code)!
          .fields.map((f) => f.code),
      ),
  });
  const api = tenantApi(testDb().db, { authorize, clock });
  const request = (method: string, path: string, options: object) =>
    api.request(method, `${TR_BASE}${path}`, { ...w.as, ...options });
  const named = (name: string) => w.field('number', { name });
  /** 这些字段对查看人不可见（创建人清空），并把字段目录切到创建人范围。 */
  const hide = async (...ids: string[]) => {
    await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.update(talentReviewFields).set({ createdBy: null }).where(inArray(talentReviewFields.id, ids)),
    );
    fieldScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: w.as.user }],
    };
  };
  return { w, request, named, hide };
}

const hintsOf = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return ((await response.json()) as CalcRuleView).hints!;
};

describe('AC-TR-calc-rule P2-08a 按完整字段路径判断可见性（不做子串匹配）', () => {
  it.each([
    ['看不到的字段名是可见字段名的前缀', '绩效', '绩效得分'],
    ['看不到的字段名是可见字段名的前半段', '绩效得', '绩效得分'],
    ['看不到的字段名是可见字段名的后缀', '得分', '绩效得分'],
    ['看不到的字段名在可见字段名中间', '效得', '绩效得分'],
  ])('%s（%s / %s）：完全可见的循环路径与类型不确定提示原样保留', async (_label, hiddenName, visibleName) => {
    const { request, named, hide } = await world('trk-r4-prefix');
    const suffix = randomUUID().slice(0, 4);
    const a = await named(`${visibleName}${suffix}`);
    const b = await named(`另一个${suffix}`);
    const c = await named(`${visibleName}${suffix}等级`);
    // 看不到的字段：名字是可见字段名的前缀 / 后缀 / 中间片段
    const hidden = await named(hiddenName);
    await hide(hidden.id);
    const items = [calcItem(a, `${pathOf(b)} + 1`), calcItem(b, `${pathOf(a)} + 1`), calcItem(c, TYPE_UNCERTAIN)];
    const created = await request('POST', CALC_RULES, { ifMatch: 0, body: calcBody(items, { enabled: false }) });
    const rule = (await created.clone().json()) as CalcRuleView;
    const saved = await hintsOf(created);
    const enabled = await hintsOf(
      await request('PATCH', `${CALC_RULES}/${rule.id}`, { ifMatch: 1, body: { enabled: true } }),
    );
    for (const hints of [saved, enabled]) {
      expect(hints.cycles).toHaveLength(1);
      expect(hints.cycles[0]).toEqual(expect.arrayContaining([pathOf(a), pathOf(b)]));
      const text = hints.warnings.join('\n');
      expect(text).toContain(`检测到循环依赖`);
      expect(text).toContain(pathOf(c));
      expect(text).not.toContain('不可见');
      expect(text).not.toContain('未显示');
    }
  });
});

describe('AC-TR-calc-rule P2-08b 提示类别来自结构化诊断（不从文案推断）', () => {
  it.each(['循环得分', '成环系数', '依赖度', '整次失败率', '检测到循环依赖'])(
    '看不到的目标字段名含诊断关键词“%s”、没有任何循环：启用与重放都只给“非循环提示未显示”，不说存在循环依赖',
    async (keyword) => {
      const { request, named, hide } = await world('trk-r4-keyword');
      const target = await named(`${keyword}${randomUUID().slice(0, 4)}`);
      const created = await request('POST', CALC_RULES, {
        ifMatch: 0,
        body: calcBody([calcItem(target, TYPE_UNCERTAIN)], { enabled: false }),
      });
      const rule = (await created.json()) as CalcRuleView;
      await hide(target.id);
      const enable = { ifMatch: 1, idempotencyKey: `trk-r4-enable-${randomUUID()}`, body: { enabled: true } };
      for (const response of [
        await request('PATCH', `${CALC_RULES}/${rule.id}`, enable),
        await request('PATCH', `${CALC_RULES}/${rule.id}`, enable),
      ]) {
        const hints = await hintsOf(response);
        expect(hints.cycles).toEqual([]);
        expect(hints.blocked).toEqual([]);
        const text = hints.warnings.join('\n');
        expect(text).not.toContain(target.name);
        expect(text).not.toContain('循环依赖');
        expect(text).toContain('未显示');
      }
    },
  );

  it('看不到的字段确实成环时仍给出循环提示（结构化类别，不受字段名影响）', async () => {
    const { request, named, hide } = await world('trk-r4-cycle');
    const [a, b] = [await named(`普通甲${randomUUID().slice(0, 4)}`), await named(`普通乙${randomUUID().slice(0, 4)}`)];
    const created = await request('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(a, `${pathOf(b)} + 1`), calcItem(b, `${pathOf(a)} + 1`)], { enabled: false }),
    });
    const rule = (await created.json()) as CalcRuleView;
    await hide(a.id, b.id);
    const hints = await hintsOf(
      await request('PATCH', `${CALC_RULES}/${rule.id}`, { ifMatch: 1, body: { enabled: true } }),
    );
    expect(hints.cycles).toEqual([]);
    expect(hints.blocked).toHaveLength(2);
    expect(hints.warnings.join('\n')).toContain('循环依赖');
    expect(JSON.stringify(hints)).not.toContain(a.name);
  });
});
