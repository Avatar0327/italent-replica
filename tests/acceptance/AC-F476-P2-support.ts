/**
 * F-476 P2 验收夹具：组织调整「预览 / 导出」在办理后的冻结读。
 * 世界：范围甲（有负责人「办理时负责人」、有一个未变更下级），HRBP 同意名称 A、负责人驳回、申请人改为 B
 * （沿用 P1 的 handledThenChanged）。「事后漂移」夹具只追加组织版本（版本链只增不改），不碰办理份。
 * 断言只看响应文本 / 节点形状，不依赖办理份内部形状。
 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { FlowWorld } from './AC-OA-approval-support.js';
import { BASE } from './AC-OA-head-support.js';
import { flatten, reader, type PreviewNode, type PreviewView } from './AC-OA-read-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';
import { handledThenChanged, type Scenario } from './AC-F476-support.js';

export const OLD_HEAD = 'ZZ_办理时负责人';
export const NEW_HEAD = 'ZZ_事后负责人';
export const CHILD_NAME = 'ZZ_未变更下级';
export const CHILD_RENAMED = 'ZZ_下级事后改名';
export const RANGE_RENAMED = 'ZZ_范围组织事后改名';

export interface P2Scene extends Scenario {
  readonly child: string;
  readonly oldHead: { userId: string; employeeId: string; name: string };
}

/** 范围甲：负责人 = 办理时负责人，下面有未变更下级；然后走 P1 的「办理时 A → 申请人改 B」。 */
export async function handledScene(w: FlowWorld): Promise<P2Scene> {
  const child = await w.org(CHILD_NAME, w.a);
  const oldHead = await w.person(OLD_HEAD, w.a);
  await w.setOrgRoles(w.a, { head: oldHead.employeeId });
  const s = await handledThenChanged(w);
  return { ...s, child, oldHead };
}

export const exportRes = (w: FlowWorld, id: string, user: string, after = false) =>
  w.call('GET', `${BASE}/${id}/preview/export?after=${after}`, {}, user);

export interface Exported {
  fileName: string;
  svg: string;
}

export async function exported(w: FlowWorld, id: string, user: string, after = false): Promise<Exported> {
  const res = await exportRes(w, id, user, after);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Exported;
}

/** 同一人在预览与导出（调整前 / 后）读到的全部文本，用于「不含某字符串」类断言。 */
export async function everything(w: FlowWorld, id: string, user: string) {
  const preview = await reader(w).preview(id, user);
  const before = await exported(w, id, user, false);
  const after = await exported(w, id, user, true);
  return { preview, before, after, text: JSON.stringify([preview, before, after]) };
}

/** 读库：组织在 asOf 的最新名称（orgName 要 HeadWorld，FlowWorld 的 head 是人员，类型不通用）。 */
export async function orgNameOf(w: FlowWorld, orgId: string, asOf = '2026-11-01'): Promise<string> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ name: string }>(
      await tx.execute(sql`SELECT name FROM org_versions WHERE org_id = ${orgId}
        AND start_date <= ${asOf}::date ORDER BY start_date DESC, version_no DESC LIMIT 1`),
    );
    return row!.name;
  });
}

export const nodeOf = (view: PreviewView, orgId: string): PreviewNode =>
  flatten(view.roots).find((n) => n.orgId === orgId)!;

/** 可信夹具：追加一条同开始日的组织新版本（改名 / 改上级）。组织版本只增不改，同 setOrgRoles。 */
export async function appendOrgVersion(w: FlowWorld, orgId: string, change: { name?: string; parentOrgId?: string }) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const [old] = await tx
      .select()
      .from(orgVersions)
      .where(eq(orgVersions.orgId, orgId))
      .orderBy(sql`version_no DESC`)
      .limit(1);
    const versionId = randomUUID();
    await tx.insert(orgVersions).values({
      ...old!,
      id: versionId,
      versionNo: old!.versionNo + 1,
      previousVersionId: old!.id,
      ...(change.name ? { name: change.name } : {}),
    });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    await tx.insert(orgHierarchyLinks).values(
      links.map((link) => ({
        ...link,
        versionId,
        ...(change.parentOrgId && link.dimension === 'admin' ? { parentOrgId: change.parentOrgId } : {}),
      })),
    );
  });
}

/**
 * 模拟 P1 形状的办理份：复制 hrbp 最新一份（先造一条同实例的办理日志），ext 里去掉 `preview`。
 * 守卫触发器照常校验；content_digest 不参与读取校验。
 */
export async function withoutPreviewInput(w: FlowWorld, userId: string) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const suffix = uniqueSuffix().replaceAll('-', '_');
    const table = `f476_p2_clone_${suffix}`;
    const [src] = resultRows<{ log: string }>(
      await tx.execute(sql`SELECT handling_log_id::text AS log FROM approval_handling_contents
        WHERE actor_user_id = ${userId} ORDER BY created_at DESC LIMIT 1`),
    );
    await tx.execute(sql`INSERT INTO approval_instance_logs
        (id, tenant_id, instance_id, seq, round, node_key, task_id, event, actor_user_id, detail)
      SELECT gen_random_uuid(), l.tenant_id, l.instance_id,
        (SELECT max(seq) + 1 FROM approval_instance_logs WHERE tenant_id = l.tenant_id AND instance_id = l.instance_id),
        l.round, l.node_key, l.task_id, l.event, l.actor_user_id, l.detail
      FROM approval_instance_logs l WHERE l.id = ${src!.log}`);
    await tx.execute(
      sql.raw(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS
      SELECT * FROM approval_handling_contents WHERE handling_log_id = '${src!.log}'`),
    );
    await tx.execute(
      sql.raw(`UPDATE ${table} SET id = gen_random_uuid(),
      handling_log_id = (SELECT id FROM approval_instance_logs
        WHERE tenant_id = ${table}.tenant_id AND instance_id = ${table}.instance_id ORDER BY seq DESC LIMIT 1),
      content = jsonb_set(content, '{ext}', (content->'ext') - 'preview')`),
    );
    await tx.execute(sql.raw(`INSERT INTO approval_handling_contents SELECT * FROM ${table}`));
  });
}

/**
 * 可信夹具：在 parentId 下批量铺 count 个直属下级（行政维度，生效日前已成立、启用），名称为 nameLength 个字。
 * 一条 SQL 铺完（HTTP 逐个建要几十分钟）；返回按顺序号排的前 keep 个组织 ID，给编制夹具用。
 */
export async function seedChildren(
  w: FlowWorld,
  parentId: string,
  count: number,
  options: { nameLength?: number; keep?: number; enabled?: boolean } = {},
): Promise<string[]> {
  const nameLength = options.nameLength ?? 12;
  const tag = `ZZ_BIG_${uniqueSuffix().replaceAll('-', '_')}_`;
  return withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`WITH n AS (
        SELECT g, gen_random_uuid() AS org_id, gen_random_uuid() AS version_id FROM generate_series(1, ${count}::int) g
      ), o AS (
        INSERT INTO org_objects (id, tenant_id) SELECT org_id, ${w.tenant.id}::uuid FROM n
      ), v AS (
        INSERT INTO org_versions
          (id, tenant_id, org_id, version_no, start_date, code, name, full_name, established_on, enabled)
        SELECT version_id, ${w.tenant.id}::uuid, org_id, 1, '2020-01-01', ${tag} || g,
          repeat('名', ${nameLength}::int), repeat('名', ${nameLength}::int), '2020-01-01', ${options.enabled ?? true}
        FROM n
      )
      INSERT INTO org_hierarchy_links (tenant_id, version_id, dimension, parent_org_id, sequence)
      SELECT ${w.tenant.id}::uuid, version_id, 'admin', ${parentId}::uuid, g FROM n`);
    // 组织名次表在提交时按全租户重算（延迟触发器登记“待重算租户”，万级节点要几十分钟）；本夹具只读组织树，
    // 不涉及人员排序，所以提交前清空登记（事务内设置，触发器见空则不重算）。
    await tx.execute(sql`SELECT set_config('personnel.rank_tenants', '', true)`);
    return resultRows<{ org_id: string }>(
      await tx.execute(sql`SELECT v.org_id::text FROM org_versions v
        JOIN org_hierarchy_links l ON l.tenant_id = v.tenant_id AND l.version_id = v.id AND l.dimension = 'admin'
        WHERE v.code LIKE ${`${tag}%`} ORDER BY l.sequence LIMIT ${options.keep ?? 0}`),
    ).map((row) => row.org_id);
  });
}

/** 可信夹具：给组织挂一份覆盖生效日的「仅本级」编制（本级 local）；sharedScheme 缺省时新建方案，返回方案 ID。 */
export async function localCapacity(w: FlowWorld, orgId: string, local: number, sharedScheme?: string) {
  const schemeId = sharedScheme ?? randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    if (!sharedScheme) {
      await tx.execute(
        sql`INSERT INTO establishment_scheme_objects (id, tenant_id) VALUES (${schemeId}, ${w.tenant.id})`,
      );
      await tx.execute(sql`INSERT INTO establishment_scheme_versions
        (tenant_id, scheme_id, version_no, code, name, cycle, maintenance_mode, enabled, start_date)
        VALUES (${w.tenant.id}, ${schemeId}, 1, ${`ZZ_S${uniqueSuffix()}`}, 'ZZ_合成方案', 'annual', 'local', true,
          '2020-01-01')`);
    }
    const objectId = randomUUID();
    await tx.execute(sql`INSERT INTO establishment_objects (id, tenant_id, org_id, scheme_id, period_start, period_end)
      VALUES (${objectId}, ${w.tenant.id}, ${orgId}, ${schemeId}, '2026-01-01', '2026-12-31')`);
    await tx.execute(sql`INSERT INTO establishment_versions
      (tenant_id, object_id, version_no, start_date, local_capacity, inclusive_capacity)
      VALUES (${w.tenant.id}, ${objectId}, 1, '2026-01-01', ${local}, NULL)`);
  });
  return schemeId;
}

/** 可信夹具：追加编制新版本（版本只增不改）；开始日在生效日之前，现值读立刻变，冻结份不该变。 */
export async function raiseLocalCapacity(w: FlowWorld, orgId: string, local: number) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO establishment_versions
      (tenant_id, object_id, version_no, start_date, local_capacity, inclusive_capacity)
      SELECT o.tenant_id, o.id, 2, '2026-02-01', ${local}, NULL FROM establishment_objects o
      WHERE o.tenant_id = ${w.tenant.id} AND o.org_id = ${orgId}::uuid`),
  );
}

/** 某实例办理份的体积（字节）。 */
export async function payloadBytes(w: FlowWorld, instanceId: string): Promise<number[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ bytes: string }>(
      await tx.execute(sql`SELECT payload_bytes::text AS bytes FROM approval_handling_contents
        WHERE instance_id = ${instanceId}::uuid ORDER BY created_at`),
    ).map((row) => Number(row.bytes)),
  );
}
