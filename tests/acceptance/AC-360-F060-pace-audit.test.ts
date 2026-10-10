/**
 * AC-360-F060 计时审计的披露（DEC-405①，第 2 轮审查必改项）：
 * 计时的建立 / 翻页 / 清除都留审计（库内保存完整快照）；产品审计接口按 20 §5 业务可见性披露——对该活动有日志审计权、
 * 且活动在其业务查看范围内的人能看到“事件存在”（事件类型、所属活动 / 评价关系 / 套卷、翻页次数），看不到耗时：
 * - 耗时、计时起点、翻页时刻（openedAt / pageStartedAt）不在任何字段、差异、前后值、快照里；
 * - 建立 / 翻页事件的发生时间模糊到租户当地日（00:00），不能与提交时间相减得出耗时；清除事件是管理员动作，照常展示；
 * - 范围外（无活动授权的一般管理员、无 360 权限者）一律看不到，与不存在一致。
 */
import { sql } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import { auditApi } from './AC-AUD-support.js';
import { world360 } from './AC-360-support.js';

const testDb = useTestDb();
const TIMING_TYPE = 'survey360-sheet-timing';
const TIMING_KEY = /openedAt|pageStartedAt|opened_at|page_started_at|duration|elapsed/i;
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
  const timingLogs = async (user: string) =>
    (await audit.dataChanges(as(user), { limit: '100', objectType: TIMING_TYPE })).items;
  return { w, activity, relation, q, audit, as, timingLogs, db };
}

async function tenantZone(s: Awaited<ReturnType<typeof scene>>): Promise<string> {
  const result = (await s.db.execute(sql`SELECT timezone FROM tenants WHERE id = ${s.w.tenantId}::uuid`)) as unknown;
  const list = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { timezone: string }[];
  return list[0]!.timezone;
}

describe('AC-360-F060 计时审计披露（DEC-405①）', () => {
  it('对象类型已登记；授权审计员看得到 建立 / 翻页 / 清除 事件，且只有这些事件类型', async () => {
    const s = await scene('f060aud-a');
    expect(auditObjectRegistered(TIMING_TYPE)).toBe(true);
    const logs = await s.timingLogs(s.w.admin);
    expect(logs.map((l) => l.action).sort()).toEqual([
      'survey360.sheet-timing.clear',
      'survey360.sheet-timing.open',
      'survey360.sheet-timing.page',
      'survey360.sheet-timing.page',
    ]);
    expect(new Set(logs.map((l) => l.objectLabel))).toEqual(new Set(['答卷计时']));
  });

  it('看不到耗时：差异、详情前后值、快照里都没有 openedAt / pageStartedAt；翻页次数与所属关系可见', async () => {
    const s = await scene('f060aud-b');
    const logs = await s.timingLogs(s.w.admin);
    const details = [];
    for (const log of logs) details.push(await s.audit.dataChange(s.as(s.w.admin), log.id));
    expect(JSON.stringify(logs)).not.toMatch(TIMING_KEY);
    expect(JSON.stringify(details)).not.toMatch(TIMING_KEY);
    const open = details.find((d) => d.action.endsWith('.open'))!;
    expect(open.after).toMatchObject({
      activityId: s.activity.id,
      relationId: s.relation.id,
      questionnaireId: s.q.id,
      pageCount: 0,
    });
    const pages = details.filter((d) => d.action.endsWith('.page'));
    expect(pages.map((d) => (d.after as { pageCount: number }).pageCount).sort()).toEqual([1, 2]);
    // 翻页事件至少有一个可见字段变化（翻页次数），所以不会被“只涉及隐藏字段”的规则吞掉
    for (const page of pages) expect(page.changes.map((c) => c.field)).toContain('pageCount');
    // 清除事件的快照保留所属关系与套卷，但没有时间字段
    const cleared = details.find((d) => d.action.endsWith('.clear'))!;
    expect(cleared.snapshot).toMatchObject({ relationId: s.relation.id, questionnaireId: s.q.id });
  });

  it('建立 / 翻页事件的发生时间模糊到租户当地日 00:00，不能与提交时间相减；三条同一天的显示相同', async () => {
    const s = await scene('f060aud-c');
    const zone = await tenantZone(s);
    const logs = await s.timingLogs(s.w.admin);
    const timed = logs.filter((l) => /\.(open|page)$/.test(l.action));
    expect(timed).toHaveLength(3);
    const shown = new Set(timed.map((l) => l.occurredAt));
    expect(shown.size).toBe(1);
    const occurred = new Date([...shown][0]!).getTime();
    for (const exact of [OPEN_AT, PAGE_1_AT, PAGE_2_AT]) {
      expect(occurred).not.toBe(exact);
      expect(tenantLocalDate(new Date(occurred), zone)).toBe(tenantLocalDate(new Date(exact), zone));
    }
    // 恰为当地日的第一刻：前一毫秒属于前一天
    expect(tenantLocalDate(new Date(occurred - 1), zone)).not.toBe(tenantLocalDate(new Date(occurred), zone));
    // 管理员的清除动作照常展示真实时间
    const cleared = logs.find((l) => l.action.endsWith('.clear'))!;
    expect(new Date(cleared.occurredAt).getTime()).toBe(T0 + 200_000);
  });

  it('范围外看不到：无活动授权的一般管理员、无 360 权限者列表为空、详情 404；授权后看得到且仍无耗时', async () => {
    const s = await scene('f060aud-d');
    const known = (await s.timingLogs(s.w.admin))[0]!;
    const general = await s.w.member('一般管理员');
    await s.w.appoint(general, 'general');
    const outsider = await s.w.member('审计员');
    expect(await s.timingLogs(general)).toEqual([]);
    expect(await s.timingLogs(outsider)).toEqual([]);
    for (const user of [general, outsider]) {
      const res = await s.audit.get(`/data-changes/${known.id}`, s.as(user));
      expect(res.status).toBe(404);
    }
    const current = await s.w.getActivity(s.activity.id);
    await s.w.ok(
      s.w.request('POST', `/activities/${s.activity.id}/grants`, {
        ifMatch: current.revision,
        body: { userIds: [general] },
      }),
    );
    const granted = await s.timingLogs(general);
    expect(granted).toHaveLength(4);
    expect(JSON.stringify(granted)).not.toMatch(TIMING_KEY);
  });
});
