import { randomUUID } from 'node:crypto';
import { grantPlatformOperator, sql, withTenant } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { configBody, configWorld } from './AC-SC-config-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { resultRows } from './AC-ORG-people-support.js';
const testDb = useTestDb();
describe('AC-SC B2a 命令、原始规则与授权', () => {
  let w: Awaited<ReturnType<typeof configWorld>>;
  beforeAll(async () => {
    w = await configWorld(testDb().db);
  });
  const rows = async (id: string) =>
    withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows(await tx.execute(sql`SELECT * FROM succession_populations WHERE id = ${id}::uuid`)),
    );
  it.each([undefined, 'invalid', 1])('AC-SC 新增要求 If-Match 0，拒绝 %s 且无写入', async (ifMatch) => {
    const before = await (await w.request('GET', '/populations')).json();
    const response = await w.raw.request('POST', '/api/tenant/succession/populations', {
      ...w.asAdmin,
      body: configBody(),
      ifMatch,
    });
    expect(response.status).toBe(ifMatch === 1 ? 409 : 400);
    expect(await response.json()).toMatchObject({
      error: { code: ifMatch === 1 ? 'REVISION_CONFLICT' : 'REVISION_REQUIRED' },
    });
    expect(await (await w.request('GET', '/populations')).json()).toEqual(before);
  });
  it('编辑 CAS、同键重放和删除快照：编码释放、审计只写一次', async () => {
    const saved = await w.create();
    const path = `/populations/${saved.id}`;
    const options = { body: { name: '青年梯队' }, ifMatch: saved.revision, idempotencyKey: randomUUID() };
    const first = await w.request('PUT', path, options);
    expect(first.status).toBe(200);
    expect(await (await w.request('PUT', path, options)).json()).toEqual(await first.json());
    expect((await w.request('PUT', path, { ...options, idempotencyKey: randomUUID() })).status).toBe(409);
    const deletion = { ifMatch: 2, idempotencyKey: randomUUID() };
    expect((await w.request('DELETE', path, deletion)).status).toBe(200);
    expect(await (await w.request('DELETE', path, deletion)).json()).toEqual({ id: saved.id, deleted: true });
    expect((await w.request('GET', path)).status).toBe(404);
    expect((await w.request('POST', '/populations', { body: { ...configBody(), code: saved.code } })).status).toBe(201);
    const audit = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ before: unknown }>(
        await tx.execute(sql`SELECT "before" FROM audit_events WHERE object_id = ${saved.id}
        AND action = 'succession.population.delete'`),
      ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ name: '青年梯队', rules: saved.rules });
  });
  it('错误行定位、未知引用、恶意字面量：拒绝且原始行／缓存／revision 不变', async () => {
    const saved = await w.create();
    const before = await rows(saved.id);
    for (const [rules, error] of [
      [
        { ...configBody().rules, expression: '1 or 99' },
        { code: 'RULE_ROW_UNKNOWN', rowNo: 99, offset: 5 },
      ],
      [
        { ...configBody().rules, expression: '1 && 2' },
        { code: 'RULE_EXPRESSION_SYNTAX', offset: 2 },
      ],
      [
        {
          ...configBody().rules,
          rows: [
            {
              ...configBody().rules.rows[0],
              field: { object: 'employee', code: 'name', path: 'employee.name', kind: 'text' },
              operator: 'eq',
              values: ['私密值"\n'],
            },
          ],
        },
        { code: 'RULE_LITERAL_INVALID', rowNo: 1 },
      ],
    ] as const) {
      const response = await w.request('PUT', `/populations/${saved.id}`, { ifMatch: 1, body: { rules } });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: { errors: [error] } } });
      expect(text).not.toContain('私密值');
      expect(await rows(saved.id)).toEqual(before);
    }
    const duplicate = await w.request('POST', '/populations', { body: { ...configBody(), code: saved.code } });
    expect(duplicate.status).toBe(409);
  });
  it('未引用行号超出 PostgreSQL integer 范围时返回 400，原对象不变', async () => {
    const saved = await w.create();
    const body = configBody();
    body.rules.rows.push({ ...body.rules.rows[0]!, rowNo: 2147483648 });
    const response = await w.request('PUT', `/populations/${saved.id}`, { ifMatch: 1, body: { rules: body.rules } });
    expect(response.status).toBe(400);
    expect(await (await w.request('GET', `/populations/${saved.id}`)).json()).toMatchObject(saved);
  });
  it('真实字段权：首次与直接重放都裁掉 name / rules；撤看全部后重放拒绝', async () => {
    const object = SUCCESSION_OBJECTS.population;
    const profile = await createProfile(w, 'sc-config-editor', { apps: ['SuccessionAndDevelopment'] });
    expect(
      (
        await setObjectPermission(
          w,
          profile,
          {
            dataOperations: { create: true, update: true, delete: true },
            fields: object.fields.map((field) => ({
              fieldCode: field.code,
              view: ['id', 'revision', 'code'].includes(field.code),
              edit: !field.system,
            })),
            buttons: object.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
          },
          object.code,
        )
      ).status,
    ).toBe(200);
    await makeGrantable(w, [profile.id]);
    const user = await addMember(w, '配置编辑者');
    expect((await grant(w, user.id, profile.id)).status).toBe(201);
    const scopePath = `/api/tenant/permission/profiles/${profile.id}/data-scopes/SuccessionAndDevelopment`;
    const scope = await w.api.request('PUT', scopePath, {
      ...w.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: object.code, seeAll: true },
    });
    expect(scope.status).toBe(200);
    const saved = await w.create();
    const path = `/api/tenant/succession/populations/${saved.id}`;
    const input = {
      user: user.id,
      tenant: w.tenant.id,
      body: { code: randomUUID() },
      ifMatch: 1,
      idempotencyKey: randomUUID(),
    };
    for (let i = 0; i < 2; i++) {
      const response = await w.api.request('PUT', path, input);
      expect(response.status, await response.clone().text()).toBe(200);
      const view = await response.json();
      expect(view).toMatchObject({ code: input.body.code });
      expect(view).not.toHaveProperty('name');
      expect(view).not.toHaveProperty('rules');
    }
    const scopeRevision = Number(scope.headers.get('etag')?.replaceAll('"', ''));
    expect(
      (
        await w.api.request('PUT', scopePath, {
          ...w.asAdmin,
          ifMatch: scopeRevision,
          body: { targetKind: 'entity', targetCode: object.code, seeAll: false },
        })
      ).status,
    ).toBe(200);
    expect((await w.api.request('PUT', path, input)).status).toBe(403);
  });
  it('平台重新编译修复缓存，不改原始条件行；普通租户用户禁止调用，同键无重复审计', async () => {
    const saved = await w.create();
    const path = '/api/platform/succession/rules/recompile';
    const options = { user: w.admin.id, body: { tenantId: w.tenant.id }, idempotencyKey: randomUUID() };
    expect((await w.raw.request('POST', path, options)).status).toBe(403);
    await grantPlatformOperator(w.db, { userId: w.admin.id, expectedRevision: 0 }, cmd());
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE succession_populations
      SET compiled_formula = '旧缓存', compiler_version = 'old' WHERE id = ${saved.id}::uuid`),
    );
    const first = await w.raw.request('POST', path, options);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await (await w.raw.request('POST', path, options)).json()).toEqual(await first.json());
    const current = await (await w.request('GET', `/populations/${saved.id}`)).json();
    expect(current).toMatchObject({ rules: saved.rules });
    expect(JSON.stringify(await rows(saved.id))).not.toContain('旧缓存');
  });
  it('编译警告与缓存版本；平台失败清缓存并定位原始行，重放不重复审计', async () => {
    const body = configBody();
    body.rules.rows.push({ ...body.rules.rows[0]!, rowNo: 2, values: [] });
    const saved = await (await w.request('POST', '/populations', { body })).json();
    expect(saved.warnings).toEqual([
      { code: 'RULE_ROW_VALUE_MISSING', rowNo: 2 },
      { code: 'RULE_ROW_UNREFERENCED', rowNo: 2 },
    ]);
    expect((await rows(saved.id))[0]).toMatchObject({ compiler_version: '1', compile_error: null });
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE succession_population_rows
      SET field_code = 'removed_field' WHERE population_id = ${saved.id}::uuid AND row_no = 1`),
    );
    const operator = await addMember(w, '平台重编译');
    await grantPlatformOperator(w.db, { userId: operator.id, expectedRevision: 0 }, cmd());
    const input = { user: operator.id, body: { tenantId: w.tenant.id }, idempotencyKey: randomUUID() };
    const path = '/api/platform/succession/rules/recompile';
    for (let i = 0; i < 2; i++) expect((await w.raw.request('POST', path, input)).status).toBe(200);
    expect((await rows(saved.id))[0]).toMatchObject({
      compiled_formula: null,
      compiler_version: null,
      compile_error: [{ code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'FIELD_UNKNOWN' }],
    });
    const view = await (await w.request('GET', `/populations/${saved.id}`)).json();
    expect(view.compileError).toEqual([
      { code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'FIELD_UNKNOWN', text: '第 1 行条件出错：规则需要重新编译' },
    ]);
    const audit = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`
      SELECT id FROM audit_events WHERE object_id = ${saved.id} AND action = 'succession.population.recompile'`),
      ),
    );
    expect(audit).toHaveLength(1);
  });
  it('配置无看全部、缺按钮、跨租户 ID 均拒绝', async () => {
    const saved = await w.create();
    const other = await configWorld(w.db);
    expect((await other.request('GET', `/populations/${saved.id}`)).status).toBe(404);
    for (const denied of ['data.scope.all', 'object.button']) {
      const api = tenantApi(w.db, { authorize: (request) => request.action !== denied });
      expect(
        (
          await api.request('PUT', `/api/tenant/succession/populations/${saved.id}`, {
            ...w.asAdmin,
            ifMatch: 1,
            body: { name: '拒绝' },
          })
        ).status,
      ).toBe(403);
    }
    expect(await (await w.request('GET', `/populations/${saved.id}`)).json()).toMatchObject({
      name: saved.name,
      revision: 1,
    });
  });
});
