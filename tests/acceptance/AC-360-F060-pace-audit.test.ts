/**
 * AC-360-F060 计时审计：只留存、不披露（DEC-409①，修订 DEC-405①）：
 * - 计时的建立 / 翻页 / 清除都在同一事务写审计，库内保存完整快照（清除带删除前快照）；
 * - 产品审计接口一律不披露这些事件：对象类型不登记查看规则（fail-closed），任何人——包括企业管理员和有活动授权的
 *   管理员——列表查不到、按编号查详情 404。计时事件的存在、次数、时间（排序 / 游标 / 命令编号）都不会成为反推耗时的旁路。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import { rows } from '../../apps/api/src/modules/survey360/context.js';
import { auditApi } from './AC-AUD-support.js';
import { world360 } from './AC-360-support.js';

const testDb = useTestDb();
const TIMING_TYPE = 'survey360-sheet-timing';
const TIMING_KEY = /openedAt|pageStartedAt|opened_at|page_started_at|duration|elapsed|sheet-timing/i;
const T0 = Date.parse('2026-10-01T02:00:00.000Z');
const OPEN_AT = T0 + 37_123;
const PAGE_1_AT = T0 + 61_456;
const PAGE_2_AT = T0 + 95_789;

async function scene(label: string) {
  const db = testDb().db;
  const w = await world360(db, label);
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const next = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity({ name: '计时审计活动' });
  const target = await w.person('被评价人');
  const object = await w.object(activity.id, target.id, [q.id]);
  const rater = await w.person('评价者');
  const relation = await w.appraiser(activity.id, object.id, rater.id, 'superior');
  await w.transition(activity.id, 'enable');
  const call = w.link(await w.token(activity.id, rater.id));
  const base = `/tasks/${relation.id}/questionnaires/${q.id}`;
  const items = [{ itemId: q.questions[0]!.id, optionId: q.scales[0]!.options[0]!.id }];
  w.setNow(new Date(OPEN_AT).toISOString());
  await w.ok(call('GET', base));
  for (const at of [PAGE_1_AT, PAGE_2_AT]) {
    w.setNow(new Date(at).toISOString());
    await w.ok(call('POST', `${base}/page-check`, { body: { items } }));
  }
  // 管理员替换套卷：清掉计时（清除事件）
  w.setNow(new Date(T0 + 200_000).toISOString());
  await w.ok(
    w.request('PUT', `/activities/${activity.id}/objects/${object.id}/questionnaires`, {
      ifMatch: object.revision,
      body: { questionnaireIds: [next.id] },
    }),
  );
  const audit = auditApi(db, '2026-10-01T03:00:00Z', { authorize: w.authorize });
  const as = (user: string) => ({ user, tenant: w.tenantId });
  const stored = async () =>
    rows<{ id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      await withTenant(db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT id, action, before, after FROM audit_events
          WHERE object_type = ${TIMING_TYPE} ORDER BY occurred_at, id`),
      ),
    );
  return { w, activity, relation, q, audit, as, stored };
}

describe('AC-360-F060 计时审计只留存不披露（DEC-409①）', () => {
  it('库内留存：建立 1 条、翻页 2 条、清除 1 条；清除带删除前快照，建立无前值', async () => {
    const s = await scene('f060aud-a');
    const events = await s.stored();
    expect(events.map((e) => e.action)).toEqual([
      'survey360.sheet-timing.open',
      'survey360.sheet-timing.page',
      'survey360.sheet-timing.page',
      'survey360.sheet-timing.clear',
    ]);
    expect(events[0]!.before).toBeNull();
    expect(events[0]!.after).toMatchObject({ activityId: s.activity.id, relationId: s.relation.id });
    expect(events[3]!.before).toMatchObject({
      relationId: s.relation.id,
      questionnaireId: s.q.id,
      openedAt: new Date(OPEN_AT).toISOString(),
      pageStartedAt: new Date(PAGE_2_AT).toISOString(),
    });
  });

  it('产品审计接口一律查不到：对象类型不登记；列表为空、整份返回里没有计时痕迹、按编号查详情 404', async () => {
    const s = await scene('f060aud-b');
    expect(auditObjectRegistered(TIMING_TYPE)).toBe(false);
    const ids = (await s.stored()).map((e) => e.id);
    expect(ids).toHaveLength(4);
    const everyone = [s.w.admin];
    for (const user of everyone) {
      const typed = await s.audit.dataChanges(s.as(user), { limit: '100', objectType: TIMING_TYPE });
      expect(typed.items).toEqual([]);
      const listed = await s.audit.dataChanges(s.as(user), { limit: '100' });
      expect(listed.items.length).toBeGreaterThan(0);
      expect(listed.items.some((i) => i.objectType === TIMING_TYPE)).toBe(false);
      expect(JSON.stringify(listed)).not.toMatch(TIMING_KEY);
      for (const id of ids) expect((await s.audit.get(`/data-changes/${id}`, s.as(user))).status).toBe(404);
    }
  });

  it('有活动授权的管理员、无活动授权的一般管理员、无 360 权限者同样查不到（授权不改变披露）', async () => {
    const s = await scene('f060aud-c');
    const ids = (await s.stored()).map((e) => e.id);
    const general = await s.w.member('一般管理员');
    await s.w.appoint(general, 'general');
    const outsider = await s.w.member('审计员');
    const current = await s.w.getActivity(s.activity.id);
    await s.w.ok(
      s.w.request('POST', `/activities/${s.activity.id}/grants`, {
        ifMatch: current.revision,
        body: { userIds: [general] },
      }),
    );
    for (const user of [general, outsider]) {
      const listed = await s.audit.dataChanges(s.as(user), { limit: '100' });
      expect(listed.items.some((i) => i.objectType === TIMING_TYPE)).toBe(false);
      expect(JSON.stringify(listed)).not.toMatch(TIMING_KEY);
      for (const id of ids) expect((await s.audit.get(`/data-changes/${id}`, s.as(user))).status).toBe(404);
    }
  });
});
