/**
 * AC-TRF-F481-01 模板维护（设计 §3.2、§12）：新建、编码 / 名称唯一、变量检查、启停与 revision、权限、没有删除路由。
 * 真库 + 真 HTTP；PGlite 与 PG16 app_owner 两套都跑。
 */
import { auditEvents, eq, esignTemplates, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denySettings, esignWorld, type TemplateView } from './AC-TRF-F481-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();

async function errorOf(response: Response) {
  const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

describe('AC-TRF-F481-01 模板维护', () => {
  it('新建两个模板 201，列表含停用、按顺序；编码创建后不可改', async () => {
    const w = await esignWorld(db().db, 'tpl');
    const a = await w.create('a', { sortOrder: 20 });
    const b = await w.create('b', { sortOrder: 10 });
    expect(a).toMatchObject({ status: 'enabled', revision: 1, sortOrder: 20 });
    const list = await w.call('GET', '/templates');
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: TemplateView[] };
    expect(items.map((i) => i.id)).toEqual([b.id, a.id]);
    const renamed = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision,
      body: { code: 'syn.esign.changed', name: a.name },
    });
    expect(await errorOf(renamed)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('编码重复 409、名称重复 409（同租户）', async () => {
    const w = await esignWorld(db().db, 'dup');
    const a = await w.create('a');
    const sameCode = await w.call('POST', '/templates', { body: w.template('x', { code: a.code }) });
    expect(await errorOf(sameCode)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'ESIGN_TEMPLATE_CODE_DUPLICATE',
    });
    const sameName = await w.call('POST', '/templates', { body: w.template('y', { name: a.name }) });
    expect(await errorOf(sameName)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'ESIGN_TEMPLATE_NAME_DUPLICATE',
    });
    const other = await esignWorld(db().db, 'dup-other');
    const crossTenant = await other.call('POST', '/templates', {
      body: w.template('z', { code: a.code, name: a.name }),
    });
    expect(crossTenant.status, '不同租户可用同一编码与名称').toBe(201);
  });

  it('正文含表外变量 400 ESIGN_TEMPLATE_VARIABLE_UNKNOWN；编辑时同样检查；长度与必填校验', async () => {
    const w = await esignWorld(db().db, 'var');
    const bad = await w.call('POST', '/templates', { body: w.template('v', { body: '你好 {不存在的变量}' }) });
    expect(await errorOf(bad)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'ESIGN_TEMPLATE_VARIABLE_UNKNOWN',
    });
    const a = await w.create('ok');
    const edit = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision,
      body: { body: '{企业名称}{未知}' },
    });
    expect(await errorOf(edit)).toMatchObject({ status: 400, reason: 'ESIGN_TEMPLATE_VARIABLE_UNKNOWN' });
    for (const invalid of [
      { name: '' },
      { name: 'x'.repeat(101) },
      { body: 'x'.repeat(20001) },
      { code: '' },
      { sortOrder: 'first' },
    ]) {
      const r = await w.call('POST', '/templates', { body: w.template('len', invalid) });
      expect(r.status, JSON.stringify(invalid).slice(0, 40)).toBe(400);
    }
    const edgeBody = `{员工姓名}${'x'.repeat(19990)}`;
    expect((await w.call('POST', '/templates', { body: w.template('edge', { body: edgeBody }) })).status).toBe(201);
  });

  it('停用 revision + 1；旧 revision 再改 409；启用后回到下拉可见的状态', async () => {
    const w = await esignWorld(db().db, 'rev');
    const a = await w.create('a');
    const disabled = await w.call('PATCH', `/templates/${a.id}`, { ifMatch: a.revision, body: { status: 'disabled' } });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ id: a.id, status: 'disabled', revision: a.revision + 1 });
    const stale = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision,
      body: { name: `ZZ_F481_${uniqueSuffix()}` },
    });
    expect(await errorOf(stale)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const enabled = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision + 1,
      body: { status: 'enabled' },
    });
    expect(await enabled.json()).toMatchObject({ status: 'enabled', revision: a.revision + 2 });
    const missing = await w.call('PATCH', `/templates/00000000-0000-4000-8000-000000000000`, {
      ifMatch: 1,
      body: { status: 'disabled' },
    });
    expect(missing.status).toBe(404);
  });

  it('没有 ESignSettings 权限 403（读写都拒）；不存在删除路由', async () => {
    const w = await esignWorld(db().db, 'perm');
    const a = await w.create('a');
    const denied = await esignWorld(db().db, 'perm-denied', denySettings);
    expect((await denied.call('GET', '/templates')).status).toBe(403);
    expect((await denied.call('POST', '/templates', { body: denied.template('n') })).status).toBe(403);
    expect(
      (await denied.call('PATCH', `/templates/${a.id}`, { ifMatch: 1, body: { status: 'disabled' } })).status,
    ).toBe(403);
    const del = await w.call('DELETE', `/templates/${a.id}`);
    expect(del.status).toBe(404);
    const still = await w.call('GET', '/templates');
    expect(((await still.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('模板的新建与停用写字段级审计，与业务同一事务', async () => {
    const w = await esignWorld(db().db, 'audit');
    const a = await w.create('a');
    await w.call('PATCH', `/templates/${a.id}`, { ifMatch: a.revision, body: { status: 'disabled' } });
    const rows = await withTenant(db().db, w.session.tenant.id, (tx) =>
      tx
        .select({ action: auditEvents.action, objectType: auditEvents.objectType })
        .from(auditEvents)
        .where(eq(auditEvents.objectId, a.id))
        .orderBy(auditEvents.occurredAt),
    );
    expect(rows.map((r) => r.action)).toEqual(['esign.template.create', 'esign.template.update']);
    expect(new Set(rows.map((r) => r.objectType))).toEqual(new Set(['esign-template']));
  });
});

/** 第 1 轮审查返工（P2-1 ～ P2-3）：中文边界正文、全空白名称、租户模板总量上限。 */
describe('AC-TRF-F481-01 返工：边界输入与总量', () => {
  it('正文 20000 个中文字：创建 201、编辑 200（请求体上限覆盖 UTF-8 与转义）；20001 个仍 400', async () => {
    const w = await esignWorld(db().db, 'cn');
    const created = await w.call('POST', '/templates', { body: w.template('cn', { body: '中'.repeat(20000) }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const a = (await created.json()) as TemplateView;
    const edited = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision,
      body: { body: '文'.repeat(20000) },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(((await edited.json()) as TemplateView).body).toHaveLength(20000);
    const over = await w.call('POST', '/templates', { body: w.template('cn2', { body: '中'.repeat(20001) }) });
    expect(over.status).toBe(400);
    const overEdit = await w.call('PATCH', `/templates/${a.id}`, {
      ifMatch: a.revision + 1,
      body: { body: '中'.repeat(20001) },
    });
    expect(overEdit.status).toBe(400);
  });

  it('请求体上限仍有界：远超正文上限的请求在其他接口与模板接口都是 413', async () => {
    const w = await esignWorld(db().db, 'huge');
    const huge = await w.call('POST', '/templates', { body: w.template('huge', { body: 'x'.repeat(200 * 1024) }) });
    expect(huge.status).toBe(413);
    const scene = await w.call('PUT', '/scenes/transfer', {
      ifMatch: 0,
      body: { validityDays: 2, remindBeforeExpiry: false, pad: 'x'.repeat(40 * 1024) },
    });
    expect(scene.status).toBe(413);
  });

  it('全空白名称：新建与编辑都 400，模板内容与 revision 不变', async () => {
    const w = await esignWorld(db().db, 'blank');
    const a = await w.create('a');
    const created = await w.call('POST', '/templates', { body: w.template('b', { name: ' \u3000 ' }) });
    expect(await errorOf(created)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const blankCode = await w.call('POST', '/templates', { body: w.template('c', { code: '   ' }) });
    expect(blankCode.status).toBe(400);
    const edited = await w.call('PATCH', `/templates/${a.id}`, { ifMatch: a.revision, body: { name: '   ' } });
    expect(await errorOf(edited)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const list = (await (await w.call('GET', '/templates')).json()) as { items: TemplateView[] };
    expect(list.items).toEqual([a]);
  });

  it('租户模板总量上限 1000：达到后写入口 409 ESIGN_TEMPLATE_LIMIT_REACHED；维护列表与启用选项都全量可用', async () => {
    const w = await esignWorld(db().db, 'limit');
    const tenantId = w.session.tenant.id;
    await w.create('first');
    const bulk = Array.from({ length: 998 }, (_, i) => ({
      tenantId,
      code: `syn.esign.bulk_${i}`,
      name: `ZZ_F481_批量_${String(i).padStart(4, '0')}`,
      body: '正文',
      sortOrder: i + 1,
    }));
    await withTenant(db().db, tenantId, (tx) => tx.insert(esignTemplates).values(bulk));
    const last = await w.call('POST', '/templates', { body: w.template('last') });
    expect(last.status, await last.clone().text()).toBe(201);
    const over = await w.call('POST', '/templates', { body: w.template('over') });
    expect(await errorOf(over)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'ESIGN_TEMPLATE_LIMIT_REACHED',
    });
    const list = await w.call('GET', '/templates');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1000);
    const options = await w.call('GET', '/template-options/transfer-form');
    expect(options.status).toBe(200);
    expect(((await options.json()) as { items: unknown[] }).items).toHaveLength(1000);
    // 达到上限后仍可编辑既有模板（不占新名额），唯一性按精确查询判定
    const target = ((await (await w.call('GET', '/templates')).json()) as { items: TemplateView[] }).items.at(-1)!;
    const dup = await w.call('PATCH', `/templates/${target.id}`, {
      ifMatch: target.revision,
      body: { name: 'ZZ_F481_批量_0000' },
    });
    expect(await errorOf(dup)).toMatchObject({ status: 409, reason: 'ESIGN_TEMPLATE_NAME_DUPLICATE' });
    const ok = await w.call('PATCH', `/templates/${target.id}`, {
      ifMatch: target.revision,
      body: { status: 'disabled' },
    });
    expect(ok.status).toBe(200);
  });
});
