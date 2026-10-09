/** F-034：25 §3.1 E3-R2，替换套卷经确认清空该对象全部作答，逐份保留删除审计快照。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rows } from '../../apps/api/src/modules/survey360/context.js';
import { auditApi } from './AC-AUD-support.js';
import { type ObjectView, type World360, world360 } from './AC-360-support.js';

const testDb = useTestDb();

async function setup(label: string, answered = true) {
  const w = await world360(testDb().db, label);
  const old = await w.enableQuestionnaire(await w.keyBehavior());
  const retained = await w.enableQuestionnaire(await w.keyBehavior());
  const next = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const object = await w.object(activity.id, (await w.person('替换对象')).id, [old.id, retained.id]);
  const other = await w.object(activity.id, (await w.person('另一对象')).id, [old.id]);
  const rater = await w.person('评价者');
  const relation = await w.appraiser(activity.id, object.id, rater.id, 'superior');
  const otherRelation = await w.appraiser(activity.id, other.id, rater.id, 'superior');
  if (answered) await w.transition(activity.id, 'enable');
  const token = answered ? await w.token(activity.id, rater.id) : '';
  if (answered) {
    await w.ok((await w.answer(token, relation.id, old, ['v4', 'v4'])) as Response);
    await w.answer(token, relation.id, retained, ['v3', 'v3'], false);
    await w.ok((await w.answer(token, otherRelation.id, old, ['v5', 'v5'])) as Response);
  }
  const path = `/activities/${activity.id}/objects/${object.id}/questionnaires`;
  const body = { questionnaireIds: [retained.id, next.id], confirmClearAnswers: true };
  const audit = auditApi(w.db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
  return { w, old, retained, next, activity, object, other, relation, otherRelation, token, path, body, audit };
}

/** 每个负向请求前后核对业务表；失败命令审计不属于业务数据。 */
async function state(w: World360, activityId: string) {
  return withTenant(w.db, w.tenantId, async (tx) => ({
    objects: await tx.execute(sql`SELECT * FROM survey360_objects WHERE activity_id = ${activityId} ORDER BY id`),
    questionnaires: await tx.execute(sql`SELECT oq.* FROM survey360_object_questionnaires oq
      JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id
      WHERE o.activity_id = ${activityId} ORDER BY oq.id`),
    sheets: await tx.execute(sql`SELECT * FROM survey360_sheets WHERE activity_id = ${activityId} ORDER BY id`),
    answers: await tx.execute(sql`SELECT a.* FROM survey360_answers a JOIN survey360_sheets s
      ON s.tenant_id = a.tenant_id AND s.id = a.sheet_id WHERE s.activity_id = ${activityId} ORDER BY a.id`),
    relations: await tx.execute(sql`SELECT * FROM survey360_relations WHERE activity_id = ${activityId} ORDER BY id`),
    links: await tx.execute(sql`SELECT * FROM survey360_links WHERE activity_id = ${activityId} ORDER BY id`),
    changes: await tx.execute(sql`SELECT * FROM audit_events WHERE after->>'activityId' = ${activityId} ORDER BY id`),
  }));
}

async function reason(response: Response) {
  return ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

describe('AC-360-F034 替换套卷清空作答', () => {
  it('AC-360-F034 未确认保持原数据；确认清空草稿与已提交答卷，保留其他对象、原链接和删除快照', async () => {
    const f = await setup('f034-clear');
    const { w, activity, object, otherRelation, old, retained, next, relation, token } = f;
    const before = await state(w, activity.id);
    for (const confirmClearAnswers of [undefined, false]) {
      const res = await w.request('PUT', f.path, {
        ifMatch: object.revision,
        body: { questionnaireIds: f.body.questionnaireIds, confirmClearAnswers },
      });
      expect(res.status).toBe(409);
      expect(await reason(res)).toBe('ANSWER_CLEAR_CONFIRMATION_REQUIRED');
      expect(await state(w, activity.id)).toEqual(before);
    }
    const controlPath = `/tasks/${otherRelation.id}/questionnaires/${old.id}`;
    const control = await w.ok(w.link(token)('GET', controlPath));
    const key = randomUUID();
    const result = await w.ok<ObjectView>(
      w.request('PUT', f.path, { ifMatch: object.revision, body: f.body, idempotencyKey: key }),
    );
    expect(result.questionnaireIds).toEqual(f.body.questionnaireIds.toSorted());
    expect(result.revision).toBe(object.revision + 1);
    expect(result.personId).toBe(object.personId);
    const after = await state(w, activity.id);
    expect(after.relations).toEqual(before.relations);
    expect(after.links).toEqual(before.links);
    expect(await w.ok(w.link(token)('GET', controlPath))).toEqual(control);
    expect((await w.link(token)('GET', `/tasks/${relation.id}/questionnaires/${old.id}`)).status).toBe(404);
    for (const q of [retained, next]) {
      const page = await w.ok<{ sheet: unknown }>(w.link(token)('GET', `/tasks/${relation.id}/questionnaires/${q.id}`));
      expect(page.sheet).toEqual({ status: 'pending', revision: 0, answers: [], suggestion: null });
    }
    const counts = await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT (SELECT count(*)::int FROM survey360_sheets) AS sheets,
        (SELECT count(*)::int FROM survey360_answers) AS answers`),
    );
    expect(rows(counts)).toEqual([{ sheets: 1, answers: 2 }]);
    const logs = (await f.audit.dataChanges({ user: w.admin, tenant: w.tenantId }, { limit: '100' })).items;
    // DEC-340③（PR #125 第 3 轮）：答卷日志一律脱敏——不带命令 ID、答卷编号与评价关系，按动作取替换清空的删除快照
    const cleared = logs.filter((log) => log.action === 'survey360.sheet.delete');
    expect(cleared).toHaveLength(2);
    for (const log of cleared) {
      expect(log.operation).toBe('delete');
      expect(log.commandId).toBeNull();
      const detail = await f.audit.dataChange({ user: w.admin, tenant: w.tenantId }, log.id);
      expect(detail.snapshot).toMatchObject({ answers: expect.any(Array) });
      expect(detail.snapshot).not.toHaveProperty('relationId');
      expect(detail.snapshot!.answers).toHaveLength(2);
    }
    expect(logs.filter((log) => log.commandId === key && log.objectType === 'survey360-object')).toHaveLength(1);
    // 同命令重放不能再次清空原链接上的新作答。
    await w.ok((await w.answer(token, relation.id, retained, ['v5', 'v5'])) as Response);
    const beforeReplay = await state(w, activity.id);
    expect(
      await w.ok(w.request('PUT', f.path, { ifMatch: object.revision, body: f.body, idempotencyKey: key })),
    ).toEqual(result);
    expect(await state(w, activity.id)).toEqual(beforeReplay);
    const changedKey = await w.request('PUT', f.path, {
      ifMatch: object.revision,
      body: { ...f.body, questionnaireIds: [next.id] },
      idempotencyKey: key,
    });
    expect(changedKey.status).toBe(409);
    expect(await state(w, activity.id)).toEqual(beforeReplay);
  });

  it('AC-360-F034 相同套卷集合（含乱序）不清空作答、不增加 revision 或业务审计', async () => {
    const f = await setup('f034-noop');
    const before = await state(f.w, f.activity.id);
    const saved = await f.w.ok<ObjectView & { activityId: string }>(
      f.w.request('PUT', f.path, {
        ifMatch: f.object.revision,
        body: { questionnaireIds: [f.retained.id, f.old.id], confirmClearAnswers: true },
      }),
    );
    expect(saved.revision).toBe(f.object.revision);
    expect(saved.personId).toBe(f.object.personId);
    expect(saved.activityId).toBe(f.activity.id);
    expect(await state(f.w, f.activity.id)).toEqual(before);
  });

  it.each(['draft', 'enabled', 'disabled'] as const)(
    'AC-360-F034 %s 无作答对象直接替换，不要求清空确认',
    async (status) => {
      const f = await setup(`f034-${status}`, false);
      if (status !== 'draft') await f.w.transition(f.activity.id, 'enable');
      if (status === 'disabled') await f.w.transition(f.activity.id, 'disable');
      const saved = await f.w.ok<ObjectView>(
        f.w.request('PUT', f.path, {
          ifMatch: f.object.revision,
          body: { questionnaireIds: [f.next.id] },
        }),
      );
      expect(saved.questionnaireIds).toEqual([f.next.id]);
      expect(saved.revision).toBe(f.object.revision + 1);
    },
  );

  it('AC-360-F034 停用后替换保留历史计分批次，目标报告标记失效，重新启停按新答卷计分', async () => {
    const f = await setup('f034-disabled');
    await f.w.transition(f.activity.id, 'disable');
    await withTenant(f.w.db, f.w.tenantId, (tx) =>
      tx.execute(sql`UPDATE survey360_objects SET report_generated_at = now() WHERE activity_id = ${f.activity.id}`),
    );
    const scores = await f.w.scores(f.activity.id, f.object.id);
    expect(scores.length).toBeGreaterThan(0);
    await f.w.ok(f.w.request('PUT', f.path, { ifMatch: f.object.revision, body: f.body }));
    expect(await f.w.scores(f.activity.id, f.object.id)).toEqual(scores);
    const marks = await withTenant(f.w.db, f.w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, report_generated_at FROM survey360_objects WHERE activity_id = ${f.activity.id}`),
    );
    const reportMarks = rows<{ id: string; report_generated_at: unknown }>(marks);
    expect(reportMarks).toContainEqual({ id: f.object.id, report_generated_at: null });
    expect(reportMarks.find((row) => row.id === f.other.id)!.report_generated_at).not.toBeNull();
    await f.w.transition(f.activity.id, 'enable');
    await f.w.ok((await f.w.answer(f.token, f.relation.id, f.next, ['v3', 'v3'])) as Response);
    await f.w.transition(f.activity.id, 'disable');
    const current = await f.w.scores(f.activity.id, f.object.id);
    expect(current.some((row) => row.questionnaireId === f.old.id)).toBe(false);
    expect(current.find((row) => row.questionnaireId === f.next.id && row.scope === 'other')!.score).toBe(3);
  });

  it('AC-360-F034 过期 revision、非法套卷、跨租户套卷、重复及空集合均拒绝且不清空', async () => {
    const f = await setup('f034-negative');
    const draft = await f.w.keyBehavior();
    const foreign = await world360(testDb().db, 'f034-foreign');
    const q = await foreign.enableQuestionnaire(await foreign.keyBehavior());
    for (const [revision, questionnaireIds, status] of [
      [f.object.revision + 1, [f.next.id], 409],
      [f.object.revision, [draft.id], 409],
      [f.object.revision, [q.id], 404],
      [f.object.revision, [f.next.id, f.next.id], 400],
      [f.object.revision, [], 400],
    ] as const) {
      const before = await state(f.w, f.activity.id);
      const res = await f.w.request('PUT', f.path, {
        ifMatch: revision,
        body: { questionnaireIds, confirmClearAnswers: true },
      });
      expect(res.status).toBe(status);
      expect(await state(f.w, f.activity.id)).toEqual(before);
    }
  });

  it('AC-360-F034 当前更新权、按钮与套卷字段编辑权在新命令和重放均校验，响应与删除快照按当前字段裁剪', async () => {
    const f = await setup('f034-permission');
    const { w } = f;
    const user = await w.member('受限编辑人');
    const standard = survey360.SURVEY360_PROFILES.find((p) => p.code === 'standard_360_general_admin')!;
    const profile = await w.defineProfile('受限编辑', standard.objects);
    await w.grantProfile(user, profile);
    const grantActivity = await w.getActivity(f.activity.id);
    await w.ok(
      w.request('POST', `/activities/${f.activity.id}/grants`, {
        ifMatch: grantActivity.revision,
        body: { userIds: [user] },
      }),
    );
    const key = randomUUID();
    await w.ok(w.as(user)('PUT', f.path, { ifMatch: f.object.revision, body: f.body, idempotencyKey: key }));
    const permission = standard.objects.find((p) => p.objectCode === survey360.SURVEY360_OBJECTS.relation.code)!;
    let revision = (await w.ok<{ revision: number }>(w.enterprise('GET', `/profiles/${profile}`))).revision;
    for (const mode of ['operation', 'button', 'field', 'view'] as const) {
      const { objectCode, ...body } = permission;
      const updated = await w.ok<{ revision: number }>(
        w.enterprise('PUT', `/profiles/${profile}/objects/${objectCode}`, {
          ifMatch: revision,
          body: {
            ...body,
            dataOperations: { ...body.dataOperations, update: mode !== 'operation' },
            buttons: mode === 'button' ? body.buttons.filter((b) => b.buttonCode !== 'update') : body.buttons,
            fields: body.fields.map((field) => ({
              ...field,
              edit: field.fieldCode === 'questionnaireIds' && mode === 'field' ? false : field.edit,
              view: field.fieldCode === 'personId' && mode === 'view' ? false : field.view,
            })),
          },
        }),
      );
      revision = updated.revision;
      const before = await state(w, f.activity.id);
      for (const idempotencyKey of [key, randomUUID()]) {
        const res = await w.as(user)('PUT', f.path, { ifMatch: f.object.revision, body: f.body, idempotencyKey });
        if (mode === 'view' && idempotencyKey === key) {
          const result = await w.ok<{ questionnaireIds: string[]; revision: number }>(res);
          expect(result).not.toHaveProperty('personId');
          expect(result.questionnaireIds).toEqual(f.body.questionnaireIds.toSorted());
        } else expect(res.status).toBe(mode === 'view' ? 409 : 403);
        expect(await state(w, f.activity.id)).toEqual(before);
      }
    }
    // Answer.answers 查看权控制逐份快照，不把答案塞入 Relation 审计。
    const answerPermission = standard.objects.find((p) => p.objectCode === survey360.SURVEY360_OBJECTS.answer.code)!;
    const { objectCode, ...answerBody } = answerPermission;
    await w.ok(
      w.enterprise('PUT', `/profiles/${profile}/objects/${objectCode}`, {
        ifMatch: revision,
        body: { ...answerBody, fields: answerBody.fields.map((f) => ({ ...f, view: f.fieldCode !== 'answers' })) },
      }),
    );
    const logs = (await f.audit.dataChanges({ user, tenant: w.tenantId }, { limit: '100' })).items;
    // DEC-340③（PR #125 第 3 轮）：答卷日志不带命令 ID，按动作取替换清空的删除快照
    const cleared = logs.filter((log) => log.action === 'survey360.sheet.delete');
    expect(cleared).toHaveLength(2);
    for (const log of cleared) {
      const detail = await f.audit.dataChange({ user, tenant: w.tenantId }, log.id);
      expect(detail.snapshot).not.toHaveProperty('answers');
      expect(detail.before).not.toHaveProperty('answers');
      expect(detail.changes.some((change) => change.field === 'answers')).toBe(false);
    }
  });

  it('AC-360-F034 活动与精细化人员范围在清空确认及重放前复核，范围外统一 404', async () => {
    const f = await setup('f034-scope');
    const { w } = f;
    const user = await w.member('范围收窄');
    await w.appoint(user, 'general');
    const before = await state(w, f.activity.id);
    const denied = await w.as(user)('PUT', f.path, { ifMatch: f.object.revision, body: f.body });
    expect(denied.status).toBe(404);
    expect(await state(w, f.activity.id)).toEqual(before);
    const current = await w.getActivity(f.activity.id);
    await w.ok(
      w.request('POST', `/activities/${f.activity.id}/grants`, {
        ifMatch: current.revision,
        body: { userIds: [user] },
      }),
    );
    const key = randomUUID();
    await w.ok(w.as(user)('PUT', f.path, { ifMatch: f.object.revision, body: f.body, idempotencyKey: key }));
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const restricted = await state(w, f.activity.id);
    for (const idempotencyKey of [key, randomUUID()]) {
      const res = await w.as(user)('PUT', f.path, { ifMatch: f.object.revision, body: f.body, idempotencyKey });
      expect(res.status).toBe(404);
      expect(await reason(res)).toBeUndefined();
      expect(await state(w, f.activity.id)).toEqual(restricted);
    }
  });

  it('AC-360-F034 业务审计不可写时整次回滚，原命令可重提成功', async () => {
    const f = await setup('f034-rollback');
    const before = await state(f.w, f.activity.id);
    const key = randomUUID();
    await f.w.db.execute(sql`CREATE FUNCTION f034_reject_clear_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE = '53100'; END $$`);
    await f.w.db.execute(sql`CREATE TRIGGER f034_reject_clear_audit BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'survey360.object.questionnaires') EXECUTE FUNCTION f034_reject_clear_audit()`);
    try {
      const res = await f.w.request('PUT', f.path, {
        ifMatch: f.object.revision,
        body: f.body,
        idempotencyKey: key,
      });
      expect(res.status).toBe(503);
      expect(await state(f.w, f.activity.id)).toEqual(before);
      const ledger = await withTenant(f.w.db, f.w.tenantId, (tx) =>
        tx.execute(sql`SELECT command_id FROM command_ledger WHERE command_id = ${key}`),
      );
      expect(rows(ledger)).toEqual([]);
    } finally {
      await f.w.db.execute(sql`DROP TRIGGER f034_reject_clear_audit ON audit_events`);
      await f.w.db.execute(sql`DROP FUNCTION f034_reject_clear_audit()`);
    }
    await f.w.ok(
      f.w.request('PUT', f.path, {
        ifMatch: f.object.revision,
        body: f.body,
        idempotencyKey: key,
      }),
    );
  });
});
