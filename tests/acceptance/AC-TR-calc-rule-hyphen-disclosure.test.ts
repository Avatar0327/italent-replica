/**
 * #327 第 3 轮（披露类，DEC-406 可后补，同根一并做）：B5 授权复核不借隐藏字段披露存在性。
 * 操作人只看得到自己创建的字段 a；别人创建、他看不到的字段 a-1 存在与否，提交 `盘点对象.a-1` 的结果必须相同
 * （都读成 a 减 1 保存成功）。授权复核与保存分析同一解释：都只按提交人可见的字段定型。
 */
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { CALC_RULES, calcBody, calcItem, calcWorld, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

/** 字段目录按创建人范围（只看自己创建的字段），其余对象看全部；四列都可见。 */
function creatorScopedFields(userId: string) {
  const authorize: Authorizer = () => true;
  const columns = new Set(
    [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields].map((field) => field.code),
  );
  registerScopeProvider(authorize, {
    scope: async (query) =>
      query.objectCode === TALENT_REVIEW_OBJECTS.field.code
        ? {
            ...EMPTY_SCOPE,
            hasDataPermission: true,
            terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: userId }],
          }
        : { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' },
    authorize: async () => true,
    fields: async () => columns,
  });
  return tenantApi(testDb().db, { authorize, clock, formulaIdBinding: false });
}

describe('AC-TR-calc-rule · B5 授权复核不借隐藏字段披露存在性（#89-4，DEC-406）', () => {
  it.each([
    ['隐藏字段 a-1 存在', true],
    ['隐藏字段 a-1 不存在', false],
  ])('只可见 a：`盘点对象.a-1` 的提交结果与是否有隐藏字段无关（%s）', async (label, hiddenExists) => {
    const w = await calcWorld(testDb().db, `r3-b5-hidden-${hiddenExists}`, { formulaIdBinding: false });
    const target = await w.numberField();
    await w.field('number', { name: 'a' });
    if (hiddenExists) {
      const hidden = await w.field('number', { name: 'a-1' });
      // 创建人为空 = 系统字段：创建人范围内看不到
      await withTenant(testDb().db, w.as.tenant, (tx) =>
        tx.execute(sql`UPDATE talent_review_fields SET created_by = NULL WHERE id = ${hidden.id}`),
      );
    }
    const response = await creatorScopedFields(w.as.user).request('POST', `${TR_BASE}${CALC_RULES}`, {
      ...w.as,
      ifMatch: 0,
      body: calcBody([calcItem(target, '盘点对象.a-1')]),
    });
    expect(response.status, `${label}：${await response.clone().text()}`).toBe(201);
    const created = (await response.json()) as CalcRuleView;
    expect(created.items.map((item) => item.formula)).toEqual(['盘点对象.a-1']);
  });
});
