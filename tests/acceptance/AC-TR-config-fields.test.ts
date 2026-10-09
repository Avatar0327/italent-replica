/**
 * R3-T04 PR-B1 盘点字段目录（设计 §2.2 fields / field_options、§2.7 预置字段、§4.3 多选不入公式）：
 * - 类型六种；number 小数位 0～4（默认 2）；option / multi_option 必须有选项，其他类型不得带选项；
 * - 编码、类型建后不可改；选项按稳定 value 比较，value 唯一，已有选项不能删除只能停用（DEC-257）；
 * - 校准前 / 校准后成对（pairRole / pairFieldId）：类型相同、角色相反、一对一，双向一致写入；成对字段不可删；
 * - 预置字段（开通租户时下发，编码固定）可改名、停用，不可删；被引用不可删（引用方登记守卫）；
 * - 预置安装可重复执行，不产生重复行。
 */
import { sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_PRESET_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { installTalentReviewPresets } from '../../apps/api/src/modules/talent-review/presets.js';
import { configBody, configWorld, type ConfigView, TR_NOW } from './AC-TR-config-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('field', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_REFERRER' : null));

const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;
const option = (value: string, extra: Record<string, unknown> = {}) => ({ value, label: `选项${value}`, ...extra });
const fieldBody = (extra: Record<string, unknown> = {}) => configBody('field', extra);
interface FieldView extends ConfigView {
  readonly kind: string;
  readonly precision: number | null;
  readonly options: { value: string; label: string; enabled: boolean; sortNo: number }[];
  readonly pairRole: string | null;
  readonly pairFieldId: string | null;
}

describe('盘点字段目录（设计 §2.2；DEC-257）', () => {
  it('六种类型；number 默认小数位 2、范围 0～4；非 number 不得带小数位', async () => {
    const w = await configWorld(testDb().db, 'trc-field-kinds');
    const number = (await w.create('field', fieldBody({ kind: 'number' }))) as FieldView;
    expect(number).toMatchObject({ kind: 'number', precision: 2, options: [], pairRole: null, preset: false });
    const zero = (await w.create('field', fieldBody({ kind: 'number', precision: 0 }))) as FieldView;
    expect(zero.precision).toBe(0);
    for (const kind of ['text', 'date', 'boolean']) {
      expect(((await w.create('field', fieldBody({ kind }))) as FieldView).precision).toBeNull();
    }
    const multi = (await w.create('field', fieldBody({ kind: 'multi_option', options: [option('a')] }))) as FieldView;
    expect(multi.kind).toBe('multi_option');
    for (const body of [{ kind: 'number', precision: 5 }, { kind: 'text', precision: 2 }, { kind: 'color' }]) {
      const response = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody(body) });
      expect([response.status, await errorCode(response)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('编码租户唯一；编码与类型建后不可改；预置 / 系统写入标记不能由请求设置', async () => {
    const w = await configWorld(testDb().db, 'trc-field-immutable');
    const field = await w.create('field');
    const dup = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody({ code: field.code }) });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'FIELD_DUPLICATE']);
    for (const body of [{ code: 'x' }, { kind: 'number' }, { preset: true }, { systemWritten: true }]) {
      const patch = await w.request('PATCH', `/fields/${field.id}`, { ifMatch: 1, body });
      expect([patch.status, await errorCode(patch)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    for (const body of [{ preset: true }, { systemWritten: true }]) {
      const create = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody(body) });
      expect(create.status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.read('field', field.id)).body).toEqual(field);
  });

  it('选项：option / multi_option 必须有选项；value 唯一；只能新增、改标签、停用，不能删除 value', async () => {
    const w = await configWorld(testDb().db, 'trc-field-options');
    const missing = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody({ kind: 'option' }) });
    expect([missing.status, await reasonOf(missing)]).toEqual([400, 'FIELD_OPTIONS_REQUIRED']);
    const stray = await w.request('POST', '/fields', {
      ifMatch: 0,
      body: fieldBody({ kind: 'text', options: [option('a')] }),
    });
    expect([stray.status, await reasonOf(stray)]).toEqual([400, 'FIELD_OPTIONS_NOT_ALLOWED']);
    const same = await w.request('POST', '/fields', {
      ifMatch: 0,
      body: fieldBody({ kind: 'option', options: [option('3'), option('3')] }),
    });
    expect([same.status, await reasonOf(same)]).toEqual([400, 'FIELD_OPTION_DUPLICATE']);
    const field = (await w.create(
      'field',
      fieldBody({ kind: 'option', options: [option('3', { sortNo: 1 }), option('2', { sortNo: 2 })] }),
    )) as FieldView;
    expect(field.options.map((item) => item.value)).toEqual(['3', '2']);
    const removed = await w.request('PATCH', `/fields/${field.id}`, { ifMatch: 1, body: { options: [option('3')] } });
    expect([removed.status, await reasonOf(removed)]).toEqual([400, 'FIELD_OPTION_REMOVED']);
    expect((await w.read('field', field.id)).body).toEqual(field);
    const changed = await w.request('PATCH', `/fields/${field.id}`, {
      ifMatch: 1,
      body: { options: [option('3', { label: '高' }), option('2', { enabled: false }), option('1')] },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const after = (await changed.json()) as FieldView;
    expect(after.revision).toBe(2);
    expect(after.options.map((item) => [item.value, item.label, item.enabled])).toEqual([
      ['3', '高', true],
      ['2', '选项2', false],
      ['1', '选项1', true],
    ]);
  });

  it('成对字段：双向一致写入；类型相同、角色相反、一对一；成对字段不可删，可以停用', async () => {
    const w = await configWorld(testDb().db, 'trc-field-pair');
    const before = (await w.create('field', fieldBody({ kind: 'number', pairRole: 'before' }))) as FieldView;
    const after = (await w.create(
      'field',
      fieldBody({ kind: 'number', pairRole: 'after', pairFieldId: before.id }),
    )) as FieldView;
    expect(after).toMatchObject({ pairRole: 'after', pairFieldId: before.id });
    const partner = (await w.read('field', before.id)).body as FieldView;
    expect(partner).toMatchObject({ pairRole: 'before', pairFieldId: after.id });
    const attempts: [number, string, Record<string, unknown>][] = [
      [400, 'PAIR_ROLE_REQUIRED', { kind: 'number', pairFieldId: before.id }],
      [400, 'PAIR_INVALID', { kind: 'number', pairRole: 'before', pairFieldId: before.id }],
      [400, 'PAIR_INVALID', { kind: 'text', pairRole: 'after', pairFieldId: before.id }],
      [409, 'PAIR_ALREADY_USED', { kind: 'number', pairRole: 'after', pairFieldId: before.id }],
    ];
    for (const [status, reason, extra] of attempts) {
      const response = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody(extra) });
      expect([response.status, await reasonOf(response)], JSON.stringify(extra)).toEqual([status, reason]);
    }
    const blocked = await w.request('DELETE', `/fields/${before.id}`, { ifMatch: partner.revision });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'FIELD_PAIRED']);
    const disabled = await w.request('PATCH', `/fields/${before.id}`, {
      ifMatch: partner.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect((await w.read('field', after.id)).body).toEqual(after);
  });

  it('被引用的字段不可删（数据不变）；未引用的可删，删除后详情 404', async () => {
    const w = await configWorld(testDb().db, 'trc-field-delete');
    const field = await w.create('field');
    referenced.add(field.id);
    const blocked = await w.request('DELETE', `/fields/${field.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'FIELD_IN_USE']);
    expect((await w.read('field', field.id)).body).toEqual(field);
    referenced.delete(field.id);
    expect((await w.request('DELETE', `/fields/${field.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.read('field', field.id)).status).toBe(404);
  });
});

describe('预置盘点字段（设计 §2.7；DEC-306①）', () => {
  const countRows = (tenant: string) =>
    withTenant(testDb().db, tenant, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM talent_review_fields WHERE preset = true`);
      return (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
    });

  it('预置清单：业绩 / 能力 / 绩效 / 潜力成对，位置字段系统写入，编码固定且互不重复', () => {
    const codes = TALENT_REVIEW_PRESET_FIELDS.map((preset) => preset.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(
      expect.arrayContaining(['achievement_before', 'achievement_after', 'tags', 'calibration_reason']),
    );
    const cells = TALENT_REVIEW_PRESET_FIELDS.filter((preset) => preset.group === 'position');
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell).toMatchObject({ kind: 'number', systemWritten: true });
    expect(TALENT_REVIEW_PRESET_FIELDS.find((preset) => preset.code === 'tags')).toMatchObject({
      kind: 'multi_option',
    });
    const level = TALENT_REVIEW_PRESET_FIELDS.find((preset) => preset.code === 'achievement_before');
    expect(level!.options?.map((item) => item.value)).toEqual(['3', '2', '1']);
  });

  it('安装是幂等的；成对字段双向一致；预置可改名、停用，不可删，编码租户唯一', async () => {
    const db = testDb().db;
    const w = await configWorld(db, 'trc-preset');
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: 'preset-test' };
    await withTenant(db, w.as.tenant, (tx) => installTalentReviewPresets(tx, write));
    await withTenant(db, w.as.tenant, (tx) => installTalentReviewPresets(tx, write));
    expect(await countRows(w.as.tenant)).toBe(TALENT_REVIEW_PRESET_FIELDS.length);
    const list = (await (await w.request('GET', '/fields?pageSize=100')).json()) as { items: FieldView[] };
    const byCode = new Map(list.items.map((field) => [field.code as string, field]));
    const before = byCode.get('achievement_before')!;
    const after = byCode.get('achievement_after')!;
    expect(before).toMatchObject({ preset: true, pairRole: 'before', pairFieldId: after.id, kind: 'option' });
    expect(after).toMatchObject({ pairRole: 'after', pairFieldId: before.id });
    expect(byCode.get('achievement_capability_cell_before')).toMatchObject({ systemWritten: true, kind: 'number' });
    const renamed = await w.request('PATCH', `/fields/${before.id}`, { ifMatch: 1, body: { name: '业绩（校准前）' } });
    expect(renamed.status).toBe(200);
    const removed = await w.request('DELETE', `/fields/${byCode.get('remark')!.id}`, { ifMatch: 1 });
    expect([removed.status, await reasonOf(removed)]).toEqual([409, 'FIELD_PRESET']);
    const dup = await w.request('POST', '/fields', { ifMatch: 0, body: fieldBody({ code: 'remark' }) });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'FIELD_DUPLICATE']);
  });

  it('开通租户时下发预置字段（与其他预置同一事务）', async () => {
    const db = testDb().db;
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-trc-preset');
    const admin = await newUser(db, 'first-admin-trc-preset');
    const exception = await newUser(db, 'exception-admin-trc-preset');
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exception.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    expect(await countRows(result.tenant.id)).toBe(TALENT_REVIEW_PRESET_FIELDS.length);
  });
});
