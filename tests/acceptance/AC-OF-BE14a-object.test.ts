/**
 * BE-14a C1（DEC-581）Offer 对象：三个新建入口与按类型必填（OF-R1 / R12，DEC-527③ / 532⑤）、编辑 / 删除 / 复制、
 * 拒绝 / 失效原因字典（A37）、转移状态两项按钮权限的登记（DEC-533④）、数据范围与 10 个视图。
 * 失效等 C2 才有入口的状态用可信 SQL 造数。
 */
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS, OFFER_OBJECT, STANDARD_PROFILES } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();
const deny =
  (...resources: string[]): Authorizer =>
  (request) =>
    !resources.some((r) => request.resource === r || request.action === r);

describe('BE-14a 新建入口与必填', () => {
  it('社招 10 项必填（类型为空按社招）；实习只 4 项；缺项 400 列出字段、不写入', async () => {
    const w = await offerWorld(testDb().db, 'required');
    const { costCenter: _c, levelId: _l, ...partial } = w.socialFields();
    const response = await w.request('POST', '', { ifMatch: 0, body: { entry: 'offer', ...partial } });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({
      reason: 'OFFER_FORM_INCOMPLETE',
      fields: ['levelId', 'costCenter'],
    });
    expect((await w.list('view=all')).total).toBe(0);
    expect(await w.social()).toMatchObject({ offerType: null, source: 'new_hire', status: 'pending' });
    expect(await w.social({ offerType: 'campus' })).toMatchObject({ offerType: 'campus' });
    expect(await w.intern()).toMatchObject({ offerType: 'intern', entry: 'intern', approvalStatus: 'unsubmitted' });
    const wrong = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', offerType: 'intern', ...w.internFields() },
    });
    expect((await errorOf(wrong)).details).toMatchObject({ reason: 'OFFER_TYPE_MISMATCH' });
  });

  it('校招生提前实习须先选一份校招 Offer 并带出基本信息；引用不存在 400；多余字段 400', async () => {
    const w = await offerWorld(testDb().db, 'campus');
    const campus = await w.social({ offerType: 'campus', mobile: '13800000000' });
    const { name: _n, personalEmail: _e, ...rest } = w.internFields();
    const early = await w.create({ entry: 'campus_early_intern', campusOfferId: campus.id, ...rest });
    expect(early).toMatchObject({
      offerType: 'intern',
      campusOfferId: campus.id,
      name: campus.name,
      personalEmail: campus.personalEmail,
      mobile: '13800000000',
    });
    const noCampus = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'campus_early_intern', ...w.internFields() },
    });
    expect((await errorOf(noCampus)).details).toMatchObject({ reason: 'OFFER_CAMPUS_REQUIRED' });
    const social = await w.social();
    const notCampus = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'campus_early_intern', campusOfferId: social.id, ...w.internFields() },
    });
    expect((await errorOf(notCampus)).details).toMatchObject({ reason: 'OFFER_CAMPUS_REQUIRED' });
    const badRef = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), levelId: crypto.randomUUID() },
    });
    expect(badRef.status).toBe(400);
    expect((await errorOf(badRef)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    const ghost = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), hrbpId: crypto.randomUUID() },
    });
    expect(ghost.status).toBe(400);
    expect((await errorOf(ghost)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    const extra = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), status: 'sent' },
    });
    expect(extra.status).toBe(400);
  });
});

describe('BE-14a 编辑、删除、复制', () => {
  it('待发可编辑（保存后重校必填）与删除，审计留快照；审批中 / 非待发不可编辑删除', async () => {
    const w = await offerWorld(testDb().db, 'edit');
    const offer = await w.social({ salaryBeforeRegular: 12000.5 });
    expect(offer.salaryBeforeRegular).toBe(12000.5);
    const cleared = await w.request('PUT', `/${offer.id}`, { ifMatch: 1, body: { costCenter: null } });
    expect((await errorOf(cleared)).details).toMatchObject({ fields: ['costCenter'] });
    const edited = await w.request('PUT', `/${offer.id}`, { ifMatch: 1, body: { plannedEntryDate: '2026-12-01' } });
    expect(await edited.json()).toMatchObject({ plannedEntryDate: '2026-12-01', revision: 2 });
    const stale = await w.request('PUT', `/${offer.id}`, { ifMatch: 1, body: { name: '过期' } });
    expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
    const removable = await w.social();
    expect((await w.request('DELETE', `/${removable.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('GET', `/${removable.id}`)).status).toBe(404);
    const audits = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT action, before FROM audit_events WHERE tenant_id=${w.tenant.id}
        AND object_id=${removable.id}`),
    );
    const rows = (Array.isArray(audits) ? audits : (audits as { rows: unknown[] }).rows) as {
      action: string;
      before: unknown;
    }[];
    expect(rows.map((a) => a.action).sort()).toEqual(['offer.create', 'offer.delete']);
    expect(rows.find((a) => a.action === 'offer.delete')!.before).toMatchObject({ id: removable.id });
    for (const [column, value] of [
      ['approval_status', 'approving'],
      ['status', 'sent'],
    ] as const) {
      const locked = await w.social();
      await w.force(locked.id, column, value);
      for (const [method, body] of [
        ['PUT', { name: '改名' }],
        ['DELETE', undefined],
      ] as const) {
        const response = await w.request(method, `/${locked.id}`, { ifMatch: 1, body });
        expect(response.status).toBe(409);
        expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_NOT_EDITABLE' });
      }
    }
  });

  it('复制只限失效：新 Offer 回待发 / 未发起审批并记被复制的 Offer，失效字段不复制；非失效 409', async () => {
    const w = await offerWorld(testDb().db, 'copy');
    const pending = await w.social();
    const denied = await w.request('POST', `/${pending.id}/copy`, { ifMatch: 1 });
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_COPY_NOT_ALLOWED' });
    const source = await w.social();
    await w.invalidated(source.id);
    const copied = await w.request('POST', `/${source.id}/copy`, { ifMatch: 1 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const body = (await copied.json()) as OfferBody;
    expect(body).toMatchObject({
      status: 'pending',
      approvalStatus: 'unsubmitted',
      copiedFromOfferId: source.id,
      name: source.name,
      invalidReasonCode: null,
      invalidAt: null,
    });
    expect(body.id).not.toBe(source.id);
    expect((await w.get(source.id)).status).toBe('invalid');
  });
});

describe('BE-14a 拒绝 / 失效原因字典（A37）', () => {
  it('预置拒绝原因 5 项、失效原因 2 项；可新增、改名、停用；编码不分大小写唯一、保存后不可改', async () => {
    const w = await offerWorld(testDb().db, 'dictionary');
    const list = async (kind: string, query = '') =>
      (
        (await (await w.request('GET', `/dictionaries/${kind}${query}`)).json()) as {
          items: { id: string; code: string; name: string; enabled: boolean; revision: number }[];
        }
      ).items;
    expect((await list('refusal-reasons')).map((i) => i.name)).toEqual([
      '薪酬福利不满意',
      '发展空间受限',
      '有更好的工作机会',
      '个人原因',
      '其他原因',
    ]);
    expect((await list('invalid-reasons')).map((i) => i.name)).toEqual(['候选人放弃', '背调不通过']);
    const taken = await w.request('POST', '/dictionaries/refusal-reasons', {
      ifMatch: 0,
      body: { code: 'Personal', name: '重复' },
    });
    expect((await errorOf(taken)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_CODE_TAKEN' });
    const added = await w.request('POST', '/dictionaries/invalid-reasons', {
      ifMatch: 0,
      body: { code: 'duplicate', name: '重复投递' },
    });
    expect(added.status).toBe(201);
    const growth = (await list('refusal-reasons')).find((i) => i.code === 'growth')!;
    const off = await w.request('PUT', `/dictionaries/refusal-reasons/${growth.id}`, {
      ifMatch: 1,
      body: { enabled: false, name: '发展受限' },
    });
    expect(await off.json()).toMatchObject({ enabled: false, name: '发展受限', revision: 2 });
    expect((await list('refusal-reasons', '?enabled=true')).map((i) => i.code)).not.toContain('growth');
    const recode = await w.request('PUT', `/dictionaries/refusal-reasons/${growth.id}`, {
      ifMatch: 2,
      body: { code: 'career' },
    });
    expect((await errorOf(recode)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_CODE_IMMUTABLE' });
    expect((await w.request('GET', '/dictionaries/unknown')).status).toBe(400);
  });

  it('字典两个写入口：缺 If-Match 400、If-Match 不对 409，均不写入；同键重放不重复写；审计归配置对象', async () => {
    const w = await offerWorld(testDb().db, 'dictionary-revision');
    const path = '/dictionaries/invalid-reasons';
    const body = { code: 'no_show', name: '未到岗' };
    const noMatch = await w.request('POST', path, { body });
    expect(noMatch.status).toBe(400);
    expect((await errorOf(noMatch)).code).toBe('REVISION_REQUIRED');
    expect((await w.request('POST', path, { ifMatch: 1, body })).status).toBe(409);
    const key = crypto.randomUUID();
    const first = await w.request('POST', path, { ifMatch: 0, body, idempotencyKey: key });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; revision: number };
    const replay = await w.request('POST', path, { ifMatch: 0, body, idempotencyKey: key });
    expect(await replay.json()).toEqual(created);
    expect((await w.request('PUT', `${path}/${created.id}`, { body: { name: '改' } })).status).toBe(400);
    const stale = await w.request('PUT', `${path}/${created.id}`, { ifMatch: 9, body: { name: '改' } });
    expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
    expect((await w.request('PUT', `${path}/${created.id}`, { ifMatch: 1, body: { name: '未报到' } })).status).toBe(
      200,
    );
    const result = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT action, object_type AS "objectType", scope_org_id AS "orgId",
        scope_employee_id AS "employeeId", actor_user_id AS "actor" FROM audit_events
        WHERE tenant_id = ${w.tenant.id} AND object_id = ${created.id}`),
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        action: 'offer_dictionary.save',
        objectType: 'offer_dictionary',
        orgId: null,
        employeeId: null,
        actor: w.user.id,
      });
  });

  it('字典写入要配置能力：没有 tenant.employment.configuration.write 时 403，读取仍可用', async () => {
    const w = await offerWorld(testDb().db, 'dictionary-deny', deny('tenant.employment.configuration.write'));
    const denied = await w.request('POST', '/dictionaries/refusal-reasons', {
      ifMatch: 0,
      body: { code: 'salary', name: '薪资' },
    });
    expect(denied.status).toBe(403);
    expect((await w.request('GET', '/dictionaries/refusal-reasons')).status).toBe(200);
  });
});

describe('BE-14a 转移状态两项按钮权限（只登记，入口随 C2）', () => {
  it('Offer 对象登记 Offer.StatusTransfer@list 与 OfferLineOpStatusTransfer@list_row，标准 HR 身份都授予；本段无转移入口', async () => {
    expect(MODULE_OBJECTS.offer.buttons).toEqual(
      expect.arrayContaining([
        { code: 'Offer.StatusTransfer', level: 'list', requires: 'update' },
        { code: 'OfferLineOpStatusTransfer', level: 'list_row', requires: 'update' },
      ]),
    );
    for (const code of ['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist']) {
      const profile = STANDARD_PROFILES.find((p) => p.code === code)!;
      const offer = profile.objects.find((o) => o.objectCode === OFFER_OBJECT)!;
      expect(offer.buttons.map((b) => `${b.buttonCode}@${b.level}`)).toEqual(
        expect.arrayContaining(['Offer.StatusTransfer@list', 'OfferLineOpStatusTransfer@list_row']),
      );
    }
    const w = await offerWorld(testDb().db, 'no-transfer');
    const offer = await w.social();
    for (const path of ['transfer', 'toolbar-transfer', 'invalidate']) {
      const response = await w.request('POST', `/${offer.id}/${path}`, { ifMatch: 1, body: {} });
      expect(response.status).toBe(404);
    }
  });
});

describe('BE-14a 数据范围', () => {
  it('没有数据范围（默认空）时列表为空、新建 404；跨租户读取 404', async () => {
    const db = testDb().db;
    const w = await offerWorld(db, 'scope');
    const offer = await w.social();
    const blind = await offerWorld(db, 'scope-blind', deny('data.scope.all'));
    expect((await blind.list('view=all')).total).toBe(0);
    const create = await blind.request('POST', '', { ifMatch: 0, body: { entry: 'offer', ...blind.socialFields() } });
    expect(create.status).toBe(404);
    expect((await w.request('GET', `/${offer.id}`, { tenant: blind.tenant.id, user: blind.user.id })).status).toBe(404);
  });
});

describe('BE-14a 视图', () => {
  it('10 个视图带编码、筛选与列序列宽；列表按视图状态 / 审批子状态过滤、可筛选、分页', async () => {
    const w = await offerWorld(testDb().db, 'views');
    const response = await w.request('GET', '/views');
    const { items } = (await response.json()) as {
      items: { key: string; code: string; columns: { label: string; width: number }[] }[];
    };
    expect(items.map((v) => v.key)).toEqual([
      'pending',
      'unsubmitted',
      'approving',
      'approved',
      'sent',
      'accepted',
      'rejected',
      'onboarded',
      'all',
      'invalid',
    ]);
    expect(items.every((v) => v.code.endsWith('NavView'))).toBe(true);
    expect(items.find((v) => v.key === 'pending')!.columns.at(-1)).toEqual({
      label: 'Offer附件',
      width: 262,
      field: null,
    });
    const a = await w.social({ name: '甲候选人' });
    await w.social({ name: '乙候选人' });
    const approving = await w.social({ name: '丙候选人' });
    await w.force(approving.id, 'approval_status', 'approving');
    const invalid = await w.social({ name: '丁候选人' });
    await w.invalidated(invalid.id);
    expect((await w.list('view=pending')).total).toBe(3);
    expect((await w.list('view=unsubmitted')).total).toBe(2);
    expect((await w.list('view=approving')).items.map((o) => o.name)).toEqual(['丙候选人']);
    expect((await w.list('view=invalid')).items.map((o) => o.name)).toEqual(['丁候选人']);
    expect((await w.list('view=all')).total).toBe(4);
    expect((await w.list(`view=pending&name=${encodeURIComponent('甲')}`)).items.map((o) => o.id)).toEqual([a.id]);
    const page = await w.list('view=all&page=2&pageSize=3');
    expect(page).toMatchObject({ total: 4 });
    expect(page.items).toHaveLength(1);
    expect((await w.request('GET', '?view=unknown')).status).toBe(400);
    expect((await w.request('GET', '?view=pending&resume=x')).status).toBe(400);
  });
});
