/**
 * AC-EMP-31（F-036-S5，设计 §4.9 / §7.1）：`GET /businesses/:id/field-origins` 与 `GET /businesses/:id`
 * 同一操作人先后各调一次的内容对拍——比较字段集合、值、来源，不只比较状态码。
 * 夹具复用 F-476 P4 的“已办”场景：调动单由审批人 A 通过，到生效日落地，随后 HR 在任职记录上把工作地改成乙地
 * （来源行 hr-record，修改时刻手写）。
 *   甲 = 范围内 HR（发起人，读现值）；乙 = 已办审批人，办理节点未披露工作地；
 *   丙 = 已办审批人，办理节点披露了工作地（办理时为甲地）而办理后被改成乙地；丁 = 办理份缺失；戊 = 入口级与资源级错误。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { appendFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { resultRows } from './AC-ORG-people-support.js';
import { AFTER, BEFORE, EMP, activateOn, handledScene, realWorld, type Scene } from './AC-F476-p4-support.js';

const testDb = useTestDb();
const MODIFIED_AT = '2026-10-07T08:09:10.000Z';

interface OriginRow {
  fieldCode: string;
  value: unknown;
  origin: { kind: string; label: string | null; at: string; sourceBusinessId: string | null } | null;
  policy: string | null;
  pending: boolean;
  suspended: boolean;
}
interface DetailBody {
  fields?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  contentView?: { mode: string };
  [key: string]: unknown;
}
interface OriginsBody {
  businessId?: string;
  contentView?: { mode: string };
  fields?: OriginRow[];
}
interface Fetched<Body> {
  status: number;
  body: Body;
}

type Fetcher = (path: string) => Promise<Response>;

async function fetched<Body>(fetcher: Fetcher, path: string): Promise<Fetched<Body>> {
  const response = await fetcher(path);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Body };
}

/** 同一操作人先后各调一次：[详情, 来源]。 */
async function both(fetcher: Fetcher, scene: Scene) {
  const detail = await fetched<DetailBody>(fetcher, `${EMP}/businesses/${scene.businessId}`);
  const origins = await fetched<OriginsBody>(fetcher, `${EMP}/businesses/${scene.businessId}/field-origins`);
  return { detail, origins };
}

/** 详情内容的字段集合（与设计 §4.9 的出数规则一致：预置 / 自定义 / 状态）。 */
const detailCodes = (detail: Fetched<DetailBody>) =>
  [
    ...Object.keys(detail.body.fields ?? {}).map((name) => `preset:${name}`),
    ...Object.keys(detail.body.customFields ?? {}).map((id) => `custom:${id}`),
    ...['employeeStatus', 'entryStatus'].filter((key) => key in detail.body).map((key) => `status:${key}`),
  ].sort();

/** 详情里某个字段编码对应的值（手写的取法：preset → fields，custom → customFields，status → 顶层）。 */
function detailValue(detail: Fetched<DetailBody>, code: string): unknown {
  const [kind, name] = code.split(':') as [string, string];
  return kind === 'preset'
    ? detail.body.fields?.[name]
    : kind === 'custom'
      ? detail.body.customFields?.[name]
      : detail.body[name];
}

const rowsOf = (origins: Fetched<OriginsBody>) => origins.body.fields ?? [];
const placeRow = (origins: Fetched<OriginsBody>) => rowsOf(origins).find((row) => row.fieldCode === 'preset:place');

const SOURCE_SEEDED_AT = '2026-10-07T09:00:00.000Z';

/** 同一员工名下另一张业务（入职业务）的 ID：它与被读的调动单是两张独立的单。 */
async function independentBusiness(scene: Scene) {
  const { w } = scene;
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ business_id: string }>(
      await tx.execute(sql`SELECT DISTINCT business_id FROM employment_payload_versions
        WHERE tenant_id = ${w.tenant.id} AND employee_id = ${scene.subjectId}::uuid
          AND business_id <> ${scene.businessId}::uuid LIMIT 1`),
    );
    return row!.business_id;
  });
}

/** 给被读业务的工作地追加一行“向后更新”来源，来源业务是另一张独立的单（手写时刻与值）。 */
async function seedPlaceSource(scene: Scene, sourceBusinessId: string) {
  const { w } = scene;
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const [version] = resultRows<{ id: string }>(
      await tx.execute(sql`SELECT id FROM employment_payload_versions
        WHERE tenant_id = ${w.tenant.id} AND business_id = ${scene.businessId}::uuid
        ORDER BY version_no DESC LIMIT 1`),
    );
    await appendFieldOrigins(tx, { tenantId: w.tenant.id, userId: w.hr.id, now: new Date(SOURCE_SEEDED_AT) }, [
      {
        fieldCode: 'preset:place',
        originKind: 'forward-update',
        value: AFTER,
        sourceBusinessId,
        businessId: scene.businessId,
        payloadVersionId: version!.id,
        employeeId: scene.subjectId,
      },
    ]);
  });
}

/** 调动单通过 → 生效日落地 → HR 在记录上把工作地改成 AFTER（乙地）。 */
async function approvedThenEdited(label: string, nodeForm?: readonly string[], withSource = false) {
  const scene = await handledScene(testDb().db, label, 'transfer', {
    action: 'approve',
    ...(nodeForm ? { nodeForm } : {}),
  });
  await activateOn(scene, '2026-10-06');
  const { w } = scene;
  w.setNow(MODIFIED_AT);
  const current = await w.business(scene.businessId);
  const patched = await w.request(w.hr.id, 'PATCH', `${EMP}/records/${scene.businessId}`, {
    ifMatch: current.revision,
    body: { fields: { place: AFTER } },
  });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const sourceId = withSource ? await independentBusiness(scene) : null;
  if (sourceId) await seedPlaceSource(scene, sourceId);
  const real = await realWorld(scene);
  await real.grantRead(scene.approver.userId);
  await real.setScope(scene.approver.userId, 'contains');
  // 从未参与审批的 HR：对象权与组织范围都经真实授权器取得，不是 allowAll
  const reader = await w.person('未参与审批的HR', scene.departmentId);
  await real.grantRead(reader.userId);
  await real.setScope(reader.userId, 'contains');
  return {
    scene,
    real,
    sourceId,
    hr: (path: string) => w.request(w.hr.id, 'GET', path),
    readerId: reader.userId,
    reader: (path: string) => real.fetch(reader.userId, path),
    approver: (path: string) => real.fetch(scene.approver.userId, path),
  };
}

describe('AC-EMP-31 内容对拍', () => {
  it('甲：范围内 HR 读现值——字段集合与值同详情逐项相等，工作地为乙地，来源是 hr-record', async () => {
    const x = await approvedThenEdited('emp31-a');
    expect([x.scene.w.hr.id, x.scene.approver.userId], '读者没有参与过这张单').not.toContain(x.readerId);
    const { detail, origins } = await both(x.reader, x.scene);
    expect(detail.status).toBe(200);
    expect(origins.status, JSON.stringify(origins.body)).toBe(200);
    expect(origins.body.contentView).toEqual(detail.body.contentView);
    expect(origins.body.contentView?.mode).toBe('live');
    expect(
      rowsOf(origins)
        .map((row) => row.fieldCode)
        .sort(),
    ).toEqual(detailCodes(detail));
    for (const row of rowsOf(origins))
      expect(row.value, row.fieldCode).toEqual(detailValue(detail, row.fieldCode) ?? null);
    expect(detail.body.fields?.place).toBe(AFTER);
    expect(placeRow(origins)).toMatchObject({
      value: AFTER,
      origin: { kind: 'hr-record', label: 'HR 补录', at: MODIFIED_AT },
      pending: false,
      suspended: false,
    });
  });

  it('乙：已办审批人、办理节点未披露工作地——两条路由都没有工作地，来源接口全文搜不到它、那次修改与来源业务 ID', async () => {
    const x = await approvedThenEdited('emp31-b', ['effectiveDate', 'departmentId'], true);
    // 现值侧确有独立来源：未参与审批的 HR 读到工作地的来源业务 ID（非空，且不是被读的这张单）
    const live = await both(x.reader, x.scene);
    expect(live.origins.status, JSON.stringify(live.origins.body)).toBe(200);
    const liveSource = placeRow(live.origins)?.origin?.sourceBusinessId;
    expect(liveSource).toBe(x.sourceId);
    expect(liveSource).toBeTruthy();
    expect(liveSource).not.toBe(x.scene.businessId);
    expect(placeRow(live.origins)?.origin?.kind).toBe('forward-update');

    const { detail, origins } = await both(x.approver, x.scene);
    expect(detail.status).toBe(200);
    expect(origins.status, JSON.stringify(origins.body)).toBe(200);
    expect(detail.body.fields).not.toHaveProperty('place');
    expect(rowsOf(origins).map((row) => row.fieldCode)).not.toContain('preset:place');
    expect(origins.body.contentView).toEqual(detail.body.contentView);
    expect(origins.body.contentView?.mode).toBe('frozen');
    const text = JSON.stringify(origins.body);
    for (const leaked of [
      'preset:place',
      'place',
      BEFORE,
      AFTER,
      'hr-record',
      'forward-update',
      MODIFIED_AT,
      liveSource!,
    ])
      expect(text, `不应出现 ${leaked}`).not.toContain(leaked);
  });

  it('丙：已办审批人、披露了工作地（办理时甲地）而办理后被改成乙地——两条路由都读到甲地，且不带来源', async () => {
    const x = await approvedThenEdited('emp31-c');
    const { detail, origins } = await both(x.approver, x.scene);
    expect(detail.status).toBe(200);
    expect(detail.body.fields?.place).toBe(BEFORE);
    expect(origins.status, JSON.stringify(origins.body)).toBe(200);
    expect(placeRow(origins)).toEqual({
      fieldCode: 'preset:place',
      value: BEFORE,
      origin: null,
      policy: null,
      pending: false,
      suspended: false,
    });
    for (const row of rowsOf(origins))
      expect(row, row.fieldCode).toMatchObject({ origin: null, policy: null, pending: false, suspended: false });
    const text = JSON.stringify(origins.body);
    for (const leaked of [AFTER, 'hr-record', MODIFIED_AT, '08:09:10'])
      expect(text, `不应出现 ${leaked}`).not.toContain(leaked);
    // 对照甲：同一单、同一时刻，HR 读到的是乙地与 hr-record
    const hr = await both(x.hr, x.scene);
    expect(placeRow(hr.origins)).toMatchObject({ value: AFTER, origin: { kind: 'hr-record' } });
  });

  it('丁：办理份缺失——两条路由都是 503 APPROVAL_HANDLING_CONTENT_MISSING，不拿现值顶替；发起人不受影响', async () => {
    const x = await approvedThenEdited('emp31-d');
    const { w, approver } = x.scene;
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
      await tx.execute(sql`DELETE FROM approval_handling_contents WHERE actor_user_id = ${approver.userId}::uuid`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
    });
    const { detail, origins } = await both(x.approver, x.scene);
    expect(detail.status).toBe(503);
    expect(origins.status, JSON.stringify(origins.body)).toBe(503);
    expect(JSON.stringify(origins.body)).toContain('APPROVAL_HANDLING_CONTENT_MISSING');
    expect(origins.body).toEqual(detail.body);
    expect(JSON.stringify(origins.body)).not.toContain(AFTER);
    expect((await both(x.hr, x.scene)).origins.status).toBe(200);
  });

  it('戊：入口级 401 / 403 两条路由相同；资源级（范围为空的旁观者）两条路由都是 404 任职业务不存在', async () => {
    const x = await approvedThenEdited('emp31-e');
    const { w, departmentId } = x.scene;
    const { real } = x;
    const unauthenticated = await both((path) => w.api.request('GET', path, {}), x.scene);
    expect(unauthenticated.detail.status).toBe(401);
    expect(unauthenticated.origins).toEqual(unauthenticated.detail);
    // 没有任何授权的成员：入口级 403
    const nobody = (await w.person('无授权者', departmentId)).userId;
    const denied = await both((path) => real.fetch(nobody, path), x.scene);
    expect([denied.detail.status, denied.origins.status]).toEqual([403, 403]);
    expect(denied.origins).toEqual(denied.detail);
    // 有对象 / 字段权但数据范围为空的旁观者：资源级，详情接口 404 任职业务不存在，来源接口同为统一 404
    const stranger = (await w.person('旁观者', departmentId)).userId;
    await real.grantRead(stranger);
    const outOfScope = await both((path) => real.fetch(stranger, path), x.scene);
    expect(outOfScope.detail.status).toBe(404);
    expect(outOfScope.origins).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: '任职业务不存在' } },
    });
  });
});
