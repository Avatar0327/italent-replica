/**
 * F-082 AC-15（台账兼容）、AC-17 的新格式写入端到端（F082-3，开关打开）与 #214 第 2 轮 P3（审计里的 hints 防御投影）：
 * - 15：B5 时代的旧台账结果在开关打开后重放，按 legacy 渲染（formulaBindings 全为 null），不出现不可见字段名；
 * - 17：开关打开后保存写出新格式审计（规范文本 + formulaBinding + fieldNames + refFieldIds），按查看人当前字段目录权限裁剪；
 * - P3：审计里意外出现的 hints 在最终出口保留匿名计数 others 与固定提示（契约 §5.2、§5.3 第 3 步），不被当普通嵌套对象整个裁掉。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { BASE, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { CALC_RULES, calcBody, calcItem, calcRuleOperator, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { f082World, renameField, type F082World } from './AC-TR-F082-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const RULE = TALENT_REVIEW_OBJECTS.calcRule;
const PLACEHOLDER = '〔不可见字段〕';

describe('AC-15 旧台账兼容', () => {
  it('B5 格式的旧台账结果在开关打开后重放：按 legacy 渲染（绑定全为 null），改名后不出现旧名称', async () => {
    const db = testDb().db;
    const w = await f082World(db, 'f082-l15'); // 开关关闭：B5 写入，台账里是名称文本
    const [target, source] = [await w.numberField(), await w.numberField()];
    const body = calcBody([calcItem(target, `盘点对象.${source.name} + 1`)]);
    const key = randomUUID();
    const first = await w.post(body, { idempotencyKey: key });
    expect(first.status).toBe(201);
    const original = (await first.json()) as CalcRuleView;

    // 同一个库换一个开关打开的应用实例，用同一个命令 ID 重放
    const on = tenantApi(db, { clock, formulaIdBinding: true });
    const replay = (headers: object = {}) =>
      on.request('POST', `${TR_BASE}${CALC_RULES}`, { ...w.as, ifMatch: 0, body, idempotencyKey: key, ...headers });
    const same = await replay();
    expect(same.status).toBe(201);
    const view = (await same.json()) as CalcRuleView;
    expect(view.id).toBe(original.id);
    expect(view.items[0]).toMatchObject({ formula: `盘点对象.${source.name} + 1`, formulaBindings: [null] });
    expect(JSON.stringify(view)).not.toContain('formulaBinding"');

    // 旧公式没有确定绑定：改名后旧名称不再是任何可见字段的名称，渲染成占位符，不泄露
    const old = source.name;
    expect((await renameField(w, source, '改名后的新名')).status).toBe(200);
    const after = (await (await replay()).json()) as CalcRuleView;
    expect(after.items[0]).toMatchObject({ formula: `盘点对象.${PLACEHOLDER} + 1`, formulaBindings: [null] });
    expect(JSON.stringify(after)).not.toContain(old);
  });
});

describe('AC-17 新格式审计 + hints 防御投影（真实授权器）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const setupRequest = (method: string, path: string, options: Record<string, unknown> = {}) =>
    setup.request(method, `${TR_BASE}${path}`, { ...world.asAdmin, ...options });
  const asWorld = () => ({ as: { tenant: world.tenant.id } }) as unknown as F082World;
  const field = async (name: string) => {
    const response = await setupRequest('POST', '/fields', {
      ifMatch: 0,
      body: configBody('field', { kind: 'number', group: 'result', name }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; name: string };
  };
  async function makeAuditor(userId: string) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  async function auditText(as: { user: string; tenant: string }, ruleId: string) {
    const audit = auditApi(testDb().db, TR_NOW.toISOString(), { authorize: undefined });
    const list = await audit.dataChanges(as, { objectType: RULE.code, limit: '100' });
    const mine = list.items.filter((item) => item.objectId === ruleId);
    const details = [];
    for (const item of mine) details.push(await audit.dataChange(as, item.id));
    return { count: mine.length, text: JSON.stringify([mine, details]), details };
  }

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock, formulaIdBinding: true }) };
    setup = tenantApi(world.db, { clock, formulaIdBinding: true });
  });

  it('保存写出新格式审计：after 是规范文本 + bound + 写入时刻名称；有字段目录访问看到写入时刻名称，无访问是占位符且无 ID', async () => {
    const [target, source] = [await field('审计目标'), await field('审计来源')];
    const version = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT version::text AS v FROM talent_review_field_catalog_versions`),
    );
    const [row] = (Array.isArray(version) ? version : (version as { rows: unknown[] }).rows) as { v: string }[];
    const created = await setupRequest('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(target, '盘点对象 . 审计来源 + 1')], { fieldCatalogVersion: Number(row!.v) }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const rule = (await created.json()) as CalcRuleView;
    // 改名：审计里仍是写入时刻的名称（对有访问的查看人），不是新名称
    expect((await renameField(asWorld(), source, '审计来源新名')).status).toBe(200);

    const raw = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT after FROM audit_events WHERE object_id = ${rule.id} AND action LIKE '%.create'`),
    );
    const [event] = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as {
      after: { items: Record<string, unknown>[] };
    }[];
    const stored = event!.after.items[0]!;
    expect(stored).toMatchObject({
      formula: `@{tr-field:${source.id}} + 1`,
      formulaBinding: 'bound',
      fieldNames: { [source.id]: '审计来源' },
      refFieldIds: [source.id],
    });

    const seeing = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    await makeAuditor(seeing.user.id);
    const visible = await auditText(seeing.as, rule.id);
    expect(visible.text).toContain('盘点对象.审计来源 + 1');
    expect(visible.text).not.toContain('@{tr-field:');

    const blind = await calcRuleOperator(world, { seeAll: true, fields: 'none' });
    await makeAuditor(blind.user.id);
    const hidden = await auditText(blind.as, rule.id);
    for (const secret of ['审计来源', source.id, '@{tr-field:']) expect(hidden.text, secret).not.toContain(secret);
    expect(hidden.text).toContain(PLACEHOLDER);
  });

  describe('审计里的 hints（防御：正常写入不含）', () => {
    const ids = { t: '', a: '', s: '' };
    let ruleId: string;

    beforeAll(async () => {
      ruleId = randomUUID();
      [ids.t, ids.a, ids.s] = [
        (await field('提示目标')).id,
        (await field('提示来源')).id,
        (await field('提示机密')).id,
      ];
      const hints = {
        order: [ids.t, ids.a, ids.s],
        blocked: [ids.t, ids.s],
        cycles: [
          [ids.t, ids.a],
          [ids.s, ids.a],
        ],
        warnings: ['提示一', '提示二', '提示三'],
      };
      await withTenant(testDb().db, world.tenant.id, (tx) =>
        insertAuditEvent(tx, {
          tenantId: world.tenant.id,
          actorUserId: world.admin.id,
          action: 'talent-review.calc-rule.update',
          objectType: RULE.code,
          objectId: ruleId,
          before: { id: ruleId, name: '提示规则', items: [] },
          after: { id: ruleId, name: '提示规则', items: [], hints },
          commandId: randomUUID(),
          occurredAt: TR_NOW,
        }),
      );
    });

    /** 查看人只看得到“自己创建”的字段：把 t、a 归到查看人名下，s 不归他。 */
    async function viewerWithFields(extra: { hidden?: readonly string[] }) {
      const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'creator', ...extra });
      await makeAuditor(viewer.user.id);
      for (const id of [ids.t, ids.a]) {
        await withTenant(testDb().db, world.tenant.id, (tx) =>
          tx.execute(sql`UPDATE talent_review_fields SET created_by = ${viewer.user.id} WHERE id = ${id}`),
        );
      }
      return viewer;
    }
    const hintsOf = async (viewer: Awaited<ReturnType<typeof viewerWithFields>>) => {
      const seen = await auditText(viewer.as, ruleId);
      const detail = seen.details[0] as { after?: { hints?: Record<string, unknown> } };
      return { hints: detail.after?.hints, text: seen.text };
    };

    it('有 items 查看权：只留目标字段可见的 order / blocked / 环；被裁掉的给匿名计数 others 和固定提示，hints 不整个消失', async () => {
      const { hints, text } = await hintsOf(await viewerWithFields({}));
      expect(hints).toBeDefined();
      expect(hints).toMatchObject({
        order: [ids.t, ids.a],
        blocked: [ids.t],
        cycles: [[ids.t, ids.a]],
        others: { order: 1, blocked: 1, warnings: 3 },
      });
      const warnings = hints!['warnings'] as string[];
      expect(warnings.join('|')).toContain('另有 3 条提示涉及不可见的字段，未显示');
      for (const secret of [ids.s, '提示一', '提示二', '提示三']) expect(text, secret).not.toContain(secret);
    });

    it('没有 items 查看权：order / blocked / cycles 全空，只有一句固定文案，others 是全部个数', async () => {
      const { hints, text } = await hintsOf(await viewerWithFields({ hidden: ['items'] }));
      expect(hints).toMatchObject({
        order: [],
        blocked: [],
        cycles: [],
        warnings: ['计算项目对你不可见，3 条提示未显示'],
        others: { order: 3, blocked: 2, warnings: 3 },
      });
      for (const secret of [ids.s, ids.t, ids.a, '提示一']) expect(text, secret).not.toContain(secret);
    });
  });
});
