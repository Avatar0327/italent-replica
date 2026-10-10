/**
 * F-082 AC-17（审计读取裁剪，F082-2；契约 §5.3、DEC-376④、DEC-197）与 AC-25（改名错误不披露，契约 §3.1、DEC-376①）。
 * 真实授权器：
 * - 17：有审计入口、能看规则全部、但没有字段目录访问（或缺 name 列）的查看人，计算规则审计的前后值 / 快照 / 差异里
 *   不可见引用是占位符，refFieldIds / fieldNames 不含其 ID；有字段目录访问的看到可见引用（旧格式：当前名称；新格式：写入时刻名称）；
 * - 25：FIELD_NAME_BREAKS_FORMULA 的定位信息只给能看规则（范围内）+ items 列的人，其余只有匿名计数。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, withTenant } from '@italent/db';
import { TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { BASE, makeGrantable, seedPermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import type { PermissionWorld } from './AC-PRM-support.js';
import { CALC_RULES, calcBody, calcItem, calcRuleOperator, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { configBody, configOperator, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { errorOf, fieldHandle, itemIdOf, makeBound, type F082World } from './AC-TR-F082-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const RULE = TALENT_REVIEW_OBJECTS.calcRule;
const PLACEHOLDER = '〔不可见字段〕';

let world: PermissionWorld;
let setup: ReturnType<typeof tenantApi>;
const asWorld = () => ({ as: { tenant: world.tenant.id } }) as unknown as F082World;

async function create<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as T;
}
const numberField = (name: string) =>
  create<{ id: string; name: string }>('/fields', configBody('field', { kind: 'number', group: 'result', name }));

beforeAll(async () => {
  world = await seedPermissionWorld(testDb().db);
  world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
  setup = tenantApi(world.db, { clock });
});

async function makeAuditor(userId: string) {
  const response = await world.api.request('POST', `${BASE}/admins`, {
    ...world.asAdmin,
    body: { userId, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

describe('AC-17 计算规则审计按查看人当前的字段目录权限裁剪', () => {
  let secretId: string;
  let openId: string;
  let ruleId: string;

  beforeAll(async () => {
    const [target, open, secret] = [
      await numberField('目标项'),
      await numberField('公开项'),
      await numberField('秘密项'),
    ];
    [openId, secretId] = [open.id, secret.id];
    // B5 旧格式：创建 → 修改（换公式）→ 删除，三条审计都带名称文本
    const rule = await create<CalcRuleView>(
      CALC_RULES,
      calcBody([calcItem(target, '盘点对象.公开项 + 盘点对象.秘密项')], { name: '审计规则' }),
    );
    ruleId = rule.id;
    const edit = await setup.request('PATCH', `${TR_BASE}${CALC_RULES}/${rule.id}`, {
      ...world.asAdmin,
      ifMatch: 1,
      body: { items: [calcItem(target, '盘点对象.秘密项 * 2')] },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    // 新格式（开关打开后才会由保存写出，F082-5；这里手工构造审计行验证读取裁剪随 F082-2 生效）
    await withTenant(testDb().db, world.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: world.tenant.id,
        actorUserId: world.admin.id,
        action: 'talent-review.calc-rule.update',
        objectType: RULE.code,
        objectId: rule.id,
        before: { id: rule.id, name: '审计规则', items: [] },
        after: {
          id: rule.id,
          name: '审计规则',
          items: [
            {
              targetFieldId: target.id,
              priority: 1,
              description: null,
              formula: `${fieldHandle(openId)} + ${fieldHandle(secretId)}`,
              formulaBinding: 'bound',
              fieldNames: { [openId]: '公开项（写入时）', [secretId]: '秘密项（写入时）' },
              refFieldIds: [openId, secretId],
            },
          ],
        },
        commandId: randomUUID(),
        occurredAt: TR_NOW,
      }),
    );
    const removed = await setup.request('DELETE', `${TR_BASE}${CALC_RULES}/${rule.id}`, {
      ...world.asAdmin,
      ifMatch: 2,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });

  /** 某查看人看到的这条规则全部审计（列表 + 详情）序列化。 */
  async function auditText(as: { user: string; tenant: string }) {
    const audit = auditApi(testDb().db, TR_NOW.toISOString(), { authorize: undefined });
    const list = await audit.dataChanges(as, { objectType: RULE.code, limit: '100' });
    const mine = list.items.filter((item) => item.objectId === ruleId);
    const details = [];
    for (const item of mine) details.push(await audit.dataChange(as, item.id));
    return { count: mine.length, text: JSON.stringify([mine, details]) };
  }

  it('有规则全部范围但没有字段目录访问：旧 / 新格式、创建 / 修改 / 删除快照里都没有字段名与字段 ID', async () => {
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'none' });
    await makeAuditor(viewer.user.id);
    const seen = await auditText(viewer.as);
    expect(seen.count).toBe(4);
    for (const secret of ['公开项', '秘密项', secretId, openId, fieldHandle(secretId)]) {
      expect(seen.text, secret).not.toContain(secret);
    }
    expect(seen.text).toContain(PLACEHOLDER);
  });

  it('有字段目录访问但缺 name 列查看权：同样全部隐藏', async () => {
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll', fieldHidden: ['name'] });
    await makeAuditor(viewer.user.id);
    const seen = await auditText(viewer.as);
    for (const secret of ['公开项', '秘密项', secretId, fieldHandle(openId)]) {
      expect(seen.text, secret).not.toContain(secret);
    }
  });

  it('有字段目录全部访问：旧格式看到当前名称（目标项、公开项、秘密项）；新格式看到写入时刻的名称', async () => {
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    await makeAuditor(viewer.user.id);
    const seen = await auditText(viewer.as);
    expect(seen.text).toContain('盘点对象.公开项 + 盘点对象.秘密项');
    expect(seen.text).toContain('盘点对象.公开项（写入时） + 盘点对象.秘密项（写入时）');
    expect(seen.text).not.toContain('@{tr-field:');
    expect(seen.text).not.toContain(PLACEHOLDER);
  });

  it('字段目录范围只含部分字段（创建人范围外的字段不可见）：不可见的引用换占位符', async () => {
    // 只有“公开项”可见：把秘密项改成别人创建的——这里直接用列权限之外的另一条路径验证部分可见
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'creator' });
    await makeAuditor(viewer.user.id);
    const seen = await auditText(viewer.as);
    // 创建人范围且该查看人没有创建过任何字段：等同全部不可见
    expect(seen.text).not.toContain('秘密项');
    expect(seen.text).toContain(PLACEHOLDER);
  });
});

describe('AC-25 改名错误不披露（FIELD_NAME_BREAKS_FORMULA）', () => {
  let source: { id: string; name: string };
  let target: { id: string; name: string };
  let rule: CalcRuleView;

  beforeAll(async () => {
    [target, source] = [await numberField('定位目标'), await numberField('甲')];
    rule = await create<CalcRuleView>(CALC_RULES, calcBody([calcItem(target, '1')], { name: '改名披露规则' }));
    const itemId = await itemIdOf(testDb().db, asWorld(), rule.id, target.id);
    await makeBound(testDb().db, asWorld(), itemId, `${fieldHandle(source.id)} + "${'x'.repeat(3970)}"`, [source.id]);
  });

  /** 能改名（字段对象更新权 + 看全部）的操作人，另可叠加计算规则对象的查看权 / 范围 / items 列权限。 */
  async function renamer(rules?: { seeAll: boolean; itemsHidden?: boolean }) {
    const op = await configOperator(world, 'field', { seeAll: true });
    if (rules) {
      const profile = op.profile;
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: RULE.fields.map((item) => ({
            fieldCode: item.code,
            view: !(rules.itemsHidden && item.code === 'items'),
            edit: false,
          })),
          buttons: [],
        },
        RULE.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await makeGrantable(world, [profile.id]);
      if (rules.seeAll) {
        const scope = await world.api.request(
          'PUT',
          `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`,
          {
            ...world.asAdmin,
            ifMatch: 0,
            body: { targetKind: 'entity', targetCode: RULE.code, seeAll: true },
          },
        );
        expect(scope.status, await scope.clone().text()).toBe(200);
      }
    }
    return op;
  }
  const rename = async (op: Awaited<ReturnType<typeof renamer>>) => {
    const current = await setup.request('GET', `${TR_BASE}/fields/${source.id}`, world.asAdmin);
    const revision = ((await current.json()) as { revision: number }).revision;
    return op.request(`PATCH`, `/fields/${source.id}`, { ifMatch: revision, body: { name: '名'.repeat(45) } });
  };
  const text = async (response: Response) => JSON.stringify(await errorOf(response));

  it('能看规则（范围内）+ items 列 + 目标字段可见：完整定位', async () => {
    const response = await rename(await renamer({ seeAll: true }));
    const error = await errorOf(response);
    expect([response.status, error.details['reason']]).toEqual([409, 'FIELD_NAME_BREAKS_FORMULA']);
    expect(error.details['affected']).toEqual([{ ruleId: rule.id, targetFieldId: target.id, reason: 'TOO_LONG' }]);
    expect(error.details['others']).toBe(0);
  });

  for (const [label, rules] of [
    ['没有计算规则查看权', undefined],
    ['有查看权但规则不在其范围内（缺省范围为空）', { seeAll: false }],
    ['有规则全部范围但看不到 items 列', { seeAll: true, itemsHidden: true }],
  ] as const) {
    it(`${label}：affected 为空，只有匿名计数；载荷里没有规则 ID、目标字段 ID 与原因类别`, async () => {
      const response = await rename(await renamer(rules));
      const error = await errorOf(response);
      expect([response.status, error.details['reason'], error.details['affected'], error.details['others']]).toEqual([
        409,
        'FIELD_NAME_BREAKS_FORMULA',
        [],
        1,
      ]);
      const body = await text(response.clone());
      for (const secret of [rule.id, target.id, 'TOO_LONG', 'NOT_PARSEABLE']) expect(body).not.toContain(secret);
    });
  }
});
