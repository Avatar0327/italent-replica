/**
 * R3-T04 PR-B2 字段映射（设计 §2.2 field_mappings、TR-R9；DEC-257、DEC-361）：
 * - 场景 carry_last（带入上次结果）/ talent_pool（入人才池）；来源与目标字段类型相同；单选 / 多选的选项值集合相同；
 *   来源可以等于目标（预置“标签 → 标签”）；同一场景同一对来源 / 目标不能重复（409 MAPPING_DUPLICATE）；
 * - 引用的字段须存在、在查看人范围内（不存在与范围外同一个 404）、已启用（停用后不可新引用，设计 §7 启停行）；
 * - 预置“标签 → 标签”映射经种子补装登记表（DEC-361）装入：开通与平台回补共用，只补缺失、不覆盖，预置映射不可改不可删；
 * - 被映射引用的字段不可删（409 FIELD_IN_USE，referrer FIELD_MAPPING）；创建审计、revision、幂等。
 * 纯函数 mappingCompatibility 供 PR-C 在带入时复核（字段选项之后可能变化）。负向用例断言具体响应码，并前后各读一次对比。
 */
import { eq, talentReviewFieldMappings, talentReviewFields, withTenant } from '@italent/db';
import { mappingCompatibility } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { auditApi } from './AC-AUD-support.js';
import { mappingBody, scoringWorld, TR_NOW, type ConfigView } from './AC-TR-scoring-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;
interface MappingView extends ConfigView {
  readonly scene: string;
  readonly sourceFieldId: string;
  readonly targetFieldId: string;
  readonly preset: boolean;
}

describe('映射兼容性（纯函数，PR-C 带入时复核）', () => {
  const field = (kind: string, ...values: string[]) => ({ kind, optionValues: values });
  it('类型相同；选项类要求值集合相同（与顺序无关）；不同类型 / 值集合不同给出具体原因', () => {
    expect(mappingCompatibility(field('text'), field('text'))).toBeNull();
    expect(mappingCompatibility(field('option', 'a', 'b'), field('option', 'b', 'a'))).toBeNull();
    expect(mappingCompatibility(field('text'), field('number'))).toBe('MAPPING_KIND_MISMATCH');
    expect(mappingCompatibility(field('option', 'a'), field('multi_option', 'a'))).toBe('MAPPING_KIND_MISMATCH');
    expect(mappingCompatibility(field('option', 'a'), field('option', 'a', 'b'))).toBe('MAPPING_OPTIONS_MISMATCH');
  });
});

describe('字段映射 · 配置规则（TR-R9）', () => {
  it('类型相同可建；来源可等于目标；类型不同 / 选项集合不同 / 重复分别拒绝；数据不变', async () => {
    const w = await scoringWorld(testDb().db, 'trm-create');
    const text = await w.field();
    const text2 = await w.field();
    const number = await w.field({ kind: 'number' });
    const ab = await w.optionField(['a', 'b']);
    const ba = await w.optionField(['b', 'a']);
    const abc = await w.optionField(['a', 'b', 'c']);
    const multi = await w.optionField(['a', 'b'], 'multi_option');
    const created = (await w.post('/field-mappings', mappingBody(text.id, text2.id))) as MappingView;
    expect(created).toMatchObject({
      scene: 'carry_last',
      sourceFieldId: text.id,
      targetFieldId: text2.id,
      preset: false,
    });
    expect(await w.post('/field-mappings', mappingBody(ab.id, ba.id, { scene: 'talent_pool' }))).toMatchObject({
      scene: 'talent_pool',
    });
    expect(await w.post('/field-mappings', mappingBody(text.id, text.id))).toMatchObject({
      sourceFieldId: text.id,
      targetFieldId: text.id,
    });
    const bad: [number, string, Record<string, unknown>][] = [
      [400, 'MAPPING_KIND_MISMATCH', mappingBody(text.id, number.id)],
      [400, 'MAPPING_KIND_MISMATCH', mappingBody(ab.id, multi.id)],
      [400, 'MAPPING_OPTIONS_MISMATCH', mappingBody(ab.id, abc.id)],
      [409, 'MAPPING_DUPLICATE', mappingBody(text.id, text2.id)],
    ];
    for (const [status, reason, body] of bad) {
      const response = await w.request('POST', '/field-mappings', { ifMatch: 0, body });
      expect([response.status, await reasonOf(response)], reason).toEqual([status, reason]);
    }
    const unknown = await w.request('POST', '/field-mappings', {
      ifMatch: 0,
      body: mappingBody(text.id, '00000000-0000-4000-8000-000000000000'),
    });
    expect([unknown.status, await errorCode(unknown)]).toEqual([404, 'NOT_FOUND']);
    const scene = await w.request('POST', '/field-mappings', {
      ifMatch: 0,
      body: mappingBody(text.id, text2.id, { scene: 'other' }),
    });
    expect([scene.status, await errorCode(scene)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      ((await (await w.request('GET', '/field-mappings?pageSize=100')).json()) as { items: unknown[] }).items,
    ).toHaveLength(3);
  });

  it('已停用字段不可新引用；修改来源 / 目标按同样规则重新校验，场景建后不可改', async () => {
    const w = await scoringWorld(testDb().db, 'trm-patch');
    const a = await w.field();
    const b = await w.field();
    const off = await w.field();
    const number = await w.field({ kind: 'number' });
    await w.request('PATCH', `/fields/${off.id}`, { ifMatch: 1, body: { enabled: false } });
    const disabled = await w.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, off.id) });
    expect([disabled.status, await reasonOf(disabled)]).toEqual([400, 'MAPPING_FIELD_DISABLED']);
    const mapping = (await w.post('/field-mappings', mappingBody(a.id, b.id))) as MappingView;
    const patch = (body: Record<string, unknown>, ifMatch = 1) =>
      w.request('PATCH', `/field-mappings/${mapping.id}`, { ifMatch, body });
    const kind = await patch({ targetFieldId: number.id });
    expect([kind.status, await reasonOf(kind)]).toEqual([400, 'MAPPING_KIND_MISMATCH']);
    const scene = await patch({ scene: 'talent_pool' });
    expect([scene.status, await errorCode(scene)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await patch({ targetFieldId: a.id }, 9)).status).toBe(409);
    expect(await (await w.request('GET', `/field-mappings/${mapping.id}`)).json()).toEqual(mapping);
    const ok = await patch({ targetFieldId: a.id });
    expect(await ok.json()).toMatchObject({ sourceFieldId: a.id, targetFieldId: a.id, revision: 2 });
  });

  it('被映射引用的字段不可删（数据不变）；映射删除后字段可删；创建 / 删除写审计，revision 冲突与幂等', async () => {
    const w = await scoringWorld(testDb().db, 'trm-delete');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const a = await w.field();
    const b = await w.field();
    const key = 'trm-create-1';
    const first = await w.request('POST', '/field-mappings', {
      ifMatch: 0,
      idempotencyKey: key,
      body: mappingBody(a.id, b.id),
    });
    const mapping = (await first.json()) as MappingView;
    const replay = await w.request('POST', '/field-mappings', {
      ifMatch: 0,
      idempotencyKey: key,
      body: mappingBody(a.id, b.id),
    });
    expect([replay.status, await replay.json()]).toEqual([201, mapping]);
    const blocked = await w.request('DELETE', `/fields/${b.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'FIELD_IN_USE', referrer: 'FIELD_MAPPING' } },
    });
    expect((await w.read('field', b.id)).status).toBe(200);
    expect((await w.request('DELETE', `/field-mappings/${mapping.id}`, { ifMatch: 5 })).status).toBe(409);
    expect((await w.request('DELETE', `/field-mappings/${mapping.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('DELETE', `/fields/${b.id}`, { ifMatch: 1 })).status).toBe(200);
    const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.FieldMapping', limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete']);
  });
});

describe('预置“标签 → 标签”映射（DEC-361 种子补装登记表）', () => {
  const mappings = (tenant: string) =>
    withTenant(testDb().db, tenant, (tx) =>
      tx.select().from(talentReviewFieldMappings).where(eq(talentReviewFieldMappings.preset, true)),
    );

  it('开通 / 回补装入同一套：缺失才装、已有不动；预置映射不可改不可删', async () => {
    const db = testDb().db;
    const w = await scoringWorld(db, 'trm-preset');
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: 'preset-mapping' };
    const run = () =>
      withTenant(db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
    const first = await run();
    expect(first.find((item) => item.key === 'preset-field-mappings')).toMatchObject({
      installed: ['carry_last:tags'],
    });
    const again = await run();
    expect(again.find((item) => item.key === 'preset-field-mappings')).toMatchObject({ installed: [], existing: 1 });
    const rows = await mappings(w.as.tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scene: 'carry_last', preset: true });
    expect(rows[0]!.sourceFieldId).toBe(rows[0]!.targetFieldId);
    const list = (await (await w.request('GET', '/field-mappings')).json()) as { items: MappingView[] };
    const preset = list.items.find((item) => item.preset)!;
    const patch = await w.request('PATCH', `/field-mappings/${preset.id}`, {
      ifMatch: 1,
      body: { scene: undefined, targetFieldId: preset.sourceFieldId },
    });
    expect([patch.status, await reasonOf(patch)]).toEqual([409, 'MAPPING_PRESET']);
    const del = await w.request('DELETE', `/field-mappings/${preset.id}`, { ifMatch: 1 });
    expect([del.status, await reasonOf(del)]).toEqual([409, 'MAPPING_PRESET']);
    expect(await mappings(w.as.tenant)).toHaveLength(1);
  });

  it('补装时租户已手工建了同一对“标签 → 标签”映射（preset = false）：识别为已有，不撞唯一约束、不覆盖租户记录', async () => {
    const db = testDb().db;
    const w = await scoringWorld(db, 'trm-preset-manual');
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: 'preset-mapping-manual' };
    const run = () =>
      withTenant(db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
    await run();
    // 模拟存量租户：预置映射是租户自己手工建的（preset = false）
    await withTenant(db, w.as.tenant, (tx) =>
      tx.update(talentReviewFieldMappings).set({ preset: false }).where(eq(talentReviewFieldMappings.preset, true)),
    );
    const before = await withTenant(db, w.as.tenant, (tx) => tx.select().from(talentReviewFieldMappings));
    const again = await run();
    expect(again.find((item) => item.key === 'preset-field-mappings')).toMatchObject({ installed: [], existing: 1 });
    expect(await withTenant(db, w.as.tenant, (tx) => tx.select().from(talentReviewFieldMappings))).toEqual(before);
  });

  it('补装前租户已停用“标签”字段：不新建映射，登记表以 skipped 返回受控原因；字段恢复后再补装才装入', async () => {
    const db = testDb().db;
    const w = await scoringWorld(db, 'trm-preset-disabled');
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: 'preset-mapping-disabled' };
    const run = () =>
      withTenant(db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
    await run();
    const setTagsEnabled = (enabled: boolean) =>
      withTenant(db, w.as.tenant, async (tx) => {
        await tx.delete(talentReviewFieldMappings);
        await tx.update(talentReviewFields).set({ enabled }).where(eq(talentReviewFields.code, 'tags'));
      });
    await setTagsEnabled(false);
    const report = (await run()).find((item) => item.key === 'preset-field-mappings')!;
    expect(report).toMatchObject({
      installed: [],
      skipped: [{ code: 'carry_last:tags', reason: 'MAPPING_FIELD_DISABLED' }],
    });
    expect(await withTenant(db, w.as.tenant, (tx) => tx.select().from(talentReviewFieldMappings))).toEqual([]);
    await withTenant(db, w.as.tenant, (tx) =>
      tx.update(talentReviewFields).set({ enabled: true }).where(eq(talentReviewFields.code, 'tags')),
    );
    const after = (await run()).find((item) => item.key === 'preset-field-mappings')!;
    expect(after).toMatchObject({ installed: ['carry_last:tags'] });
    expect(after).not.toHaveProperty('skipped');
  });
});
