/**
 * R2-T08 BE-10e：AC-OA-44——架构图导出（路由 28，设计 §10A、§9.3 #28；DEC-644 范围、DEC-650①、DEC-653）。
 * 能打开详情的人都能导出（与路由 13 同一判定），不能打开的 404；`after` 切换调整前 / 后；只含调整范围子树；
 * 节点只有名称 / 负责人 / 分管领导（恒“--”）/ 编制，无人数；不可见字段“--”；文件名两态同名、取下载当天（租户时区）。
 * 编制变化箭头随 11f 生成行，接口级只断言“无编制调整时只显示 编制 {值} 或 --”；箭头渲染见 AC-OA-44-svg。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { ALL, BASE, expectError, only } from './AC-OA-head-support.js';
import { type ItemsWorld, itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { approvalFixture, orgName } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

interface ExportView {
  fileName: string;
  svg: string;
}

const exportRes = (w: ItemsWorld, id: string, after: string | null, user = w.hr.id) =>
  w.call('GET', `${BASE}/${id}/preview/export${after === null ? '' : `?after=${after}`}`, {}, user);

async function exported(w: ItemsWorld, id: string, after: boolean, user?: string): Promise<ExportView> {
  const res = await exportRes(w, id, String(after), user);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ExportView;
}

const unescapeXml = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

/** 每个节点的 `<text>` 文字，按出现顺序（名称、[状态标签]、负责人、值、分管领导、值、编制、值）。 */
function nodes(svg: string): string[][] {
  return svg
    .split('<g class="org-node"')
    .slice(1)
    .map((chunk) => [...chunk.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => unescapeXml(m[1]!)));
}

/** 可信夹具：给组织挂一个覆盖生效日 2026-11-01 的编制（方案维护方式 mode）。 */
async function capacityOf(
  w: ItemsWorld,
  orgId: string,
  values: { inclusive?: number; local?: number },
  mode: 'local' | 'inclusive' | 'both' = 'inclusive',
  sharedScheme?: string,
) {
  const schemeId = sharedScheme ?? randomUUID();
  const objectId = randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    if (!sharedScheme) {
      await tx.execute(
        sql`INSERT INTO establishment_scheme_objects (id, tenant_id) VALUES (${schemeId}, ${w.tenant.id})`,
      );
      await tx.execute(sql`INSERT INTO establishment_scheme_versions
        (tenant_id, scheme_id, version_no, code, name, cycle, maintenance_mode, start_date)
        VALUES (${w.tenant.id}, ${schemeId}, 1, ${`ZZ_S${uniqueSuffix()}`}, 'ZZ_合成方案', 'annual', ${mode},
          '2020-01-01')`);
    }
    await tx.execute(sql`INSERT INTO establishment_objects (id, tenant_id, org_id, scheme_id, period_start, period_end)
      VALUES (${objectId}, ${w.tenant.id}, ${orgId}, ${schemeId}, '2026-01-01', '2026-12-31')`);
    await tx.execute(sql`INSERT INTO establishment_versions
      (tenant_id, object_id, version_no, start_date, local_capacity, inclusive_capacity)
      VALUES (${w.tenant.id}, ${objectId}, 1, '2026-01-01', ${values.local ?? null}, ${values.inclusive ?? null})`);
  });
  return schemeId;
}

/** 下载当天：租户时区 Asia/Shanghai 已到 10-02，UTC 仍是 10-01；生效日是 11-01。 */
const DOWNLOAD_AT = '2026-10-01T17:30:00.000Z';
const DOWNLOAD_DAY = '20261002';
const FIELDS = (head: string, establishment: string) => ['负责人', head, '分管领导', '--', '编制', establishment];

describe('AC-OA-44 架构图导出：两态、范围子树、四个节点字段、文件名', () => {
  it('调整前带“停用 / 新增 / 变更”标签；调整后停用组织不出现且无状态标记；无人数；两态同名', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const headName = `ZZ_负责人${uniqueSuffix()}`;
    const head = await w.employee(headName);
    await w.setOrgRoles(w.a, { head: head.id });
    const c = await w.org(`ZZ_丙${uniqueSuffix()}`, w.a);
    const d = await w.org(`ZZ_丁${uniqueSuffix()}`, w.a);
    const outside = await w.org(`ZZ_范围外${uniqueSuffix()}`, w.b);
    await capacityOf(w, w.a, { inclusive: 7 });
    await capacityOf(w, d, { inclusive: 3 });
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = (await w.item(view.id, newOrg(w.a, { name: `ZZ_新${uniqueSuffix()}` }))).items.at(-1)!;
    const renamed = (await w.item(view.id, rename(c, { name: `ZZ_改${uniqueSuffix()}` }))).items.at(-1)!;
    await w.item(view.id, stop(d));
    w.setNow(DOWNLOAD_AT);

    const before = await exported(w, view.id, false);
    const after = await exported(w, view.id, true);
    const [aName, dName] = [await orgName(w, w.a), await orgName(w, d)];
    expect(before.fileName).toBe(`架构图（${aName}）_${DOWNLOAD_DAY}`);
    expect(after.fileName).toBe(before.fileName);

    const beforeNodes = nodes(before.svg);
    expect(beforeNodes[0]).toEqual([aName, ...FIELDS(headName, '7')]);
    expect(beforeNodes).toHaveLength(4);
    expect(beforeNodes).toEqual(
      expect.arrayContaining([
        [dName, '停用', ...FIELDS('--', '3')],
        [added.name, '新增', ...FIELDS('--', '--')],
        [renamed.name, '变更', ...FIELDS('--', '--')],
      ]),
    );
    const afterNodes = nodes(after.svg);
    expect(afterNodes[0]).toEqual(beforeNodes[0]);
    expect(afterNodes).toHaveLength(3);
    expect(afterNodes).toEqual(
      expect.arrayContaining([
        [added.name, ...FIELDS('--', '--')],
        [renamed.name, ...FIELDS('--', '--')],
      ]),
    );
    expect(afterNodes.flat()).not.toContain(dName);

    for (const { svg } of [before, after]) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox="0 0 \d+ \d+"/,
      );
      for (const absent of [await orgName(w, outside), await orgName(w, w.subject), await orgName(w, w.b)]) {
        expect(svg).not.toContain(absent);
      }
      // 无人数、无页眉 / 图例：除节点文字外没有其它 <text>
      expect(svg).not.toMatch(/在岗|兼岗|人数|图例/);
      expect(svg.match(/<text\b/g)!.length).toBe(nodes(svg).flat().length);
    }
    for (const tag of ['停用', '新增', '变更']) expect(afterNodes.flat()).not.toContain(tag);
  });

  it('多个所选组织：按选择顺序并列，文件名以“、”连接；“仅本级”方案的编制按含下级汇总；过长名称截断为“…”', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const long = `ZZ_${'很长的组织名称'.repeat(8)}`;
    const child = await w.org(long, w.b);
    const scheme = await capacityOf(w, w.b, { local: 2 }, 'local');
    await capacityOf(w, child, { local: 3 }, 'local', scheme);
    const view = await w.created(w.head({ adjustmentRange: [w.b, w.a] }));
    const odd = (await w.item(view.id, newOrg(w.a, { name: `ZZ_<b>&"'${uniqueSuffix()}` }))).items.at(-1)!;
    w.setNow(DOWNLOAD_AT);

    const result = await exported(w, view.id, true);
    const [aName, bName] = [await orgName(w, w.a), await orgName(w, w.b)];
    expect(result.fileName).toBe(`架构图（${bName}、${aName}）_${DOWNLOAD_DAY}`);
    const list = nodes(result.svg);
    expect(list.map((texts) => texts[0])).toEqual([bName, expect.stringMatching(/…$/), aName, odd.name]);
    expect(list[0]).toEqual([bName, ...FIELDS('--', '5')]);
    const cut = list[1]![0]!;
    expect(cut.length).toBeLessThan(long.length);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(list[1]!.slice(1)).toEqual(FIELDS('--', '3'));
    expect(result.svg).not.toContain(long);
    // 名称里的 XML 特殊字符按文本转义，不成为标签
    expect(result.svg).not.toContain('<b>');
    expect(result.svg).toContain('&lt;b&gt;&amp;');
  });
});

describe('AC-OA-44 架构图导出：权限随详情、参数校验、不可见字段“--”', () => {
  it('HR（读权 + 范围）与可打开审批实例的审批人能导出；不能打开详情、主体组织范围外、不存在 404；after 缺省或非法 400', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const approver = await w.member('合成审批人');
    const stranger = await w.member('合成旁人');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = (await w.item(view.id, newOrg(w.a, { name: `ZZ_新${uniqueSuffix()}` }))).items.at(-1)!;
    await approvalFixture(w, view.id, approver, ['subject', 'adjustmentRange', 'orgItems.adjustType', 'orgItems.name']);

    expect(nodes((await exported(w, view.id, false)).svg)).toHaveLength(2);
    for (const after of [null, '', 'yes', 'TRUE', '1']) {
      await expectError(await exportRes(w, view.id, after), 400, 'VALIDATION_FAILED');
    }
    await expectError(await w.call('GET', `${BASE}/not-a-uuid/preview/export?after=true`), 400, 'VALIDATION_FAILED');
    await expectError(await exportRes(w, randomUUID(), 'true'), 404, 'NOT_FOUND');

    // 测试授权器对所有成员同一口径：收回读权与范围后，只剩审批实例这条路
    w.access.viewDenied = true;
    w.access.main = EMPTY_SCOPE;
    w.access.org = EMPTY_SCOPE;
    // 不能打开详情（无读权、不是审批人）：与详情同一 404，文案相同
    const detail = await w.call('GET', `${BASE}/${view.id}`, {}, stranger);
    const denied = await exportRes(w, view.id, 'true', stranger);
    await expectError(detail, 404, 'NOT_FOUND');
    await expectError(denied, 404, 'NOT_FOUND');
    expect((await denied.json()).error.message).toBe((await detail.json()).error.message);
    const approverNodes = nodes((await exported(w, view.id, false, approver)).svg);
    expect(approverNodes).toEqual([
      [await orgName(w, w.a), ...FIELDS('--', '--')],
      [added.name, '新增', ...FIELDS('--', '--')],
    ]);
    // 有读权但主体组织不在范围：同样 404
    w.access.viewDenied = false;
    w.access.main = only(randomUUID());
    w.access.org = ALL;
    await expectError(await exportRes(w, view.id, 'false', stranger), 404, 'NOT_FOUND');
  });

  it('看不到调整范围 / 明细名称 → 节点名称、负责人、编制、文件名里的组织名都是“--”，不泄露', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const approver = await w.member('合成审批人');
    const headName = `ZZ_负责人${uniqueSuffix()}`;
    await w.setOrgRoles(w.a, { head: (await w.employee(headName)).id });
    await capacityOf(w, w.a, { inclusive: 9 });
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = (await w.item(view.id, newOrg(w.a, { name: `ZZ_新${uniqueSuffix()}` }))).items.at(-1)!;
    await approvalFixture(w, view.id, approver, ['subject', 'orgItems.adjustType', 'orgItems.parentOrgId']);
    w.setNow(DOWNLOAD_AT);
    const aName = await orgName(w, w.a);

    w.access.hiddenFields = new Set(['adjustmentRange', 'orgItems.name']);
    const hr = await exported(w, view.id, false);
    w.access.hiddenFields = new Set();
    w.access.viewDenied = true;
    const viaApproval = await exported(w, view.id, false, approver);
    for (const result of [hr, viaApproval]) {
      expect(result.fileName).toBe(`架构图（--）_${DOWNLOAD_DAY}`);
      expect(nodes(result.svg)).toEqual([
        ['--', ...FIELDS('--', '--')],
        ['--', '新增', ...FIELDS('--', '--')],
      ]);
      for (const secret of [aName, headName, added.name!, '9']) expect(result.svg).not.toContain(`>${secret}<`);
      expect(result.svg).not.toContain(aName);
      expect(result.svg).not.toContain(headName);
    }
  });
});
