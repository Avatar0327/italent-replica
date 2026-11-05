/**
 * R2-T08 BE-10e：AC-OA-44——架构图导出（路由 28，设计 §10A、§9.3 #28；DEC-644 范围、DEC-650①、DEC-653）。
 * 能打开详情的人都能导出（与路由 13 同一判定），不能打开的 404；`after` 切换调整前 / 后；只含调整范围子树；
 * 节点只有名称 / 负责人 / 分管领导（恒“--”）/ 编制，无人数；不可见字段“--”；文件名两态同名、取下载当天（租户时区）。
 * 编制变化箭头随 11f 生成行，接口级只断言“无编制调整时只显示 编制 {值} 或 --”；箭头渲染见 AC-OA-44-svg。
 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { ALL, BASE, expectError, only } from './AC-OA-head-support.js';
import { type ItemsWorld, itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { approvalFixture, orgName, reader } from './AC-OA-read-support.js';
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
  scheme: { code?: string; enabled?: boolean; cycle?: 'annual' | 'monthly'; period?: readonly [string, string] } = {},
) {
  const schemeId = sharedScheme ?? randomUUID();
  const objectId = randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    if (!sharedScheme) {
      await tx.execute(
        sql`INSERT INTO establishment_scheme_objects (id, tenant_id) VALUES (${schemeId}, ${w.tenant.id})`,
      );
      await tx.execute(sql`INSERT INTO establishment_scheme_versions
        (tenant_id, scheme_id, version_no, code, name, cycle, maintenance_mode, enabled, start_date)
        VALUES (${w.tenant.id}, ${schemeId}, 1, ${scheme.code ?? `ZZ_S${uniqueSuffix()}`}, 'ZZ_合成方案',
          ${scheme.cycle ?? 'annual'},
          ${mode}, ${scheme.enabled ?? true}, '2020-01-01')`);
    }
    await tx.execute(sql`INSERT INTO establishment_objects (id, tenant_id, org_id, scheme_id, period_start, period_end)
      VALUES (${objectId}, ${w.tenant.id}, ${orgId}, ${schemeId}, ${scheme.period?.[0] ?? '2026-01-01'},
        ${scheme.period?.[1] ?? '2026-12-31'})`);
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

/** XML 1.0 Char 产生式之外的码点（含孤立代理项）；合规解析器遇到即判文档不良构。 */
const XML_INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;

/** XML 解析器校验：结构用 DOMParser（image/svg+xml）解析无 parsererror，字符按 XML 1.0 Char 产生式校验。 */
function expectWellFormedXml(svg: string) {
  expect(XML_INVALID.test(svg), JSON.stringify(svg.match(XML_INVALID)?.[0])).toBe(false);
  const doc = new new Window().DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  expect(doc.documentElement.tagName.toLowerCase()).toBe('svg');
}

describe('AC-OA-44 第 2 轮返工：姓名口径、XML 字符、编制汇总范围、多方案选择', () => {
  it('负责人经人员档案改名后：人员 GET、路由 15 预览、路由 28 导出三处是同一个新姓名', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const suffix = uniqueSuffix();
    const head = await w.employee(`ZZ_旧名${suffix}`);
    await w.setOrgRoles(w.a, { head: head.id });
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const newName = `ZZ_新名${suffix}`;
    const personnel = `/api/tenant/personnel/employees/${head.id}`;
    const patched = await w.request(w.hr.id, 'PATCH', personnel, { ifMatch: 0, body: { name: newName } });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const person = await w.request(w.hr.id, 'GET', personnel);
    expect(person.status, await person.clone().text()).toBe(200);
    expect(((await person.json()) as { name: string }).name).toBe(newName);
    const preview = await reader(w).preview(view.id);
    expect(preview.roots[0]!.personInChargeName).toBe(newName);
    for (const after of [false, true]) {
      const svg = (await exported(w, view.id, after)).svg;
      expect(nodes(svg)[0]).toEqual([await orgName(w, w.a), ...FIELDS(newName, '--')]);
      expect(svg).not.toContain(`ZZ_旧名${suffix}`);
    }
  });

  it('组织名称、负责人姓名、文件名含 XML 1.0 不允许的控制字符：导出仍是良构 XML，非法控制字符被滤掉', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const suffix = uniqueSuffix();
    const range = await w.org(`ZZ_范\u0001围${suffix}`);
    const head = await w.employee(`ZZ_负责人${suffix}`);
    const personnel = `/api/tenant/personnel/employees/${head.id}`;
    const headName = `ZZ_负\u000B责\u001F人${suffix}`;
    const patched = await w.request(w.hr.id, 'PATCH', personnel, { ifMatch: 0, body: { name: headName } });
    expect(patched.status, await patched.clone().text()).toBe(200);
    await w.setOrgRoles(range, { head: head.id });
    const view = await w.created(w.head({ adjustmentRange: [range] }));
    const added = (await w.item(view.id, newOrg(range, { name: `ZZ_A\u0001B${suffix}` }))).items.at(-1)!;
    expect(added.name).toBe(`ZZ_A\u0001B${suffix}`);
    w.setNow(DOWNLOAD_AT);

    for (const after of [false, true]) {
      const result = await exported(w, view.id, after);
      expectWellFormedXml(result.svg);
      expect(result.fileName).toBe(`架构图（ZZ_范围${suffix}）_${DOWNLOAD_DAY}`);
      const list = nodes(result.svg);
      expect(list[0]).toEqual([`ZZ_范围${suffix}`, ...FIELDS(`ZZ_负责人${suffix}`, '--')]);
      expect(list[1]![0]).toBe(`ZZ_AB${suffix}`);
    }
  });

  it('“仅本级”方案：上级本级编制 2147483647、下级 1，预览与导出都成功，含下级为 2147483648', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const child = await w.org(`ZZ_下级${uniqueSuffix()}`, w.b);
    const scheme = await capacityOf(w, w.b, { local: 2147483647 }, 'local');
    await capacityOf(w, child, { local: 1 }, 'local', scheme);
    const view = await w.created(w.head({ adjustmentRange: [w.b] }));

    const preview = await w.call('GET', `${BASE}/${view.id}/preview`);
    expect(preview.status, await preview.clone().text()).toBe(200);
    const roots = ((await preview.json()) as { roots: { establishment: number | null }[] }).roots;
    expect(roots[0]!.establishment).toBe(2147483648);
    const list = nodes((await exported(w, view.id, false)).svg);
    expect(list.map((texts) => texts.at(-1))).toEqual(['2147483648', '1']);
  });

  it('同一组织多个方案的编制：排除已停用方案；启用方案里 DEFAULT 优先，其余按编码升序取第一个（每个组织各自区分旧实现）', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const suffix = uniqueSuffix();
    const c = await w.org(`ZZ_丙${suffix}`);
    const add = (orgId: string, inclusive: number, code: string, enabled = true) =>
      capacityOf(w, orgId, { inclusive }, 'inclusive', undefined, { code, enabled });
    // 组织甲：已停用方案编码最小（不排除停用就取到 11）；启用的两个方案按编码取小者（取大者得 23）
    await add(w.a, 11, `ZZ_A${suffix}`, false);
    await add(w.a, 23, `ZZ_C${suffix}`);
    await add(w.a, 22, `ZZ_B${suffix}`);
    // 组织乙：编码小的 A01 先录入，DEFAULT 后录入且编码更大（不优先默认方案就取到 33）
    await add(w.b, 33, 'A01');
    await add(w.b, 44, 'DEFAULT');
    // 组织丙：已停用的 DEFAULT 不能靠“默认优先”胜出（77）；启用的两个方案里编码小的后录入（按录入顺序或取大者都得 55）
    await add(c, 77, 'DEFAULT', false);
    await add(c, 55, `ZZ_D${suffix}`);
    await add(c, 66, `ZZ_C${suffix}`);
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b, c] }));

    const preview = await reader(w).preview(view.id);
    expect(preview.roots.map((root) => [root.orgId, root.establishment])).toEqual([
      [w.a, 22],
      [w.b, 44],
      [c, 66],
    ]);
    const list = nodes((await exported(w, view.id, false)).svg);
    expect(list.map((texts) => texts.at(-1))).toEqual(['22', '44', '66']);
  });

  it('F-446 同一组织跨年并存的方案：按生效日所在周期取那一条，不因“另一年的方案编码更优先”取错', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const s = uniqueSuffix();
    // 2026 年度方案（编码大）与 2027 年的月度方案（DEFAULT 编码，若不按期间过滤就会胜出）
    await capacityOf(w, w.a, { inclusive: 10 }, 'inclusive', undefined, { code: `ZZ_Y${s}` });
    await capacityOf(w, w.a, { inclusive: 20 }, 'inclusive', undefined, {
      code: 'DEFAULT',
      cycle: 'monthly',
      period: ['2027-02-01', '2027-02-28'],
    });
    const in2026 = await w.created(w.head({ adjustmentRange: [w.a], effectiveDate: '2026-11-01' }));
    const in2027 = await w.created(w.head({ adjustmentRange: [w.a], effectiveDate: '2027-02-10' }));
    const beyond = await w.created(w.head({ adjustmentRange: [w.a], effectiveDate: '2028-01-01' }));

    expect((await reader(w).preview(in2026.id)).roots[0]!.establishment).toBe(10);
    expect((await reader(w).preview(in2027.id)).roots[0]!.establishment).toBe(20);
    // 生效日不在任何周期内：没有编制，显示“--”（北森：未设编制的组织显示“--”）
    expect((await reader(w).preview(beyond.id)).roots[0]!.establishment).toBeNull();
    expect(nodes((await exported(w, beyond.id, false)).svg)[0]!.at(-1)).toBe('--');
  });

  it('F-446 多方案取值与录入顺序无关：正序 / 倒序各一个组织；编码按码元比较（大写先于小写）；DEFAULT 先录入也优先', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const s = uniqueSuffix();
    const [c1, c2, c3, c4] = [
      await w.org(`ZZ_丙${s}`),
      await w.org(`ZZ_丁${s}`),
      await w.org(`ZZ_戊${s}`),
      await w.org(`ZZ_己${s}`),
    ];
    const add = (orgId: string, inclusive: number, code: string) =>
      capacityOf(w, orgId, { inclusive }, 'inclusive', undefined, { code });
    await add(c1, 1, `ZZ_C1${s}`); // 编码小的先录入
    await add(c1, 2, `ZZ_D1${s}`);
    await add(c2, 3, `ZZ_D2${s}`); // 编码小的后录入
    await add(c2, 4, `ZZ_C2${s}`);
    await add(c3, 5, `ZZ_a3${s}`); // 小写后于大写：不按区域排序
    await add(c3, 6, `ZZ_B3${s}`);
    await add(c4, 7, 'DEFAULT'); // 默认方案先录入
    await add(c4, 8, `ZZ_A4${s}`);
    const view = await w.created(w.head({ adjustmentRange: [c1, c2, c3, c4] }));

    const preview = await reader(w).preview(view.id);
    const byOrg = Object.fromEntries(preview.roots.map((root) => [root.orgId, root.establishment]));
    expect(byOrg).toEqual({ [c1]: 1, [c2]: 4, [c3]: 6, [c4]: 7 });
  });
});

/** 可信夹具：给组织追加一条自 `startDate` 起生效的改名版本（版本链只追加，行政上下级沿用）。 */
async function renameFrom(w: ItemsWorld, orgId: string, name: string, startDate: string) {
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
      startDate,
      name,
      fullName: name,
    });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
  });
}

describe('AC-OA-44 F-447 导出文件名取组织当前名（DEC-783）；卡片与调整明细仍按生效日', () => {
  /** 生效日 2026-11-01；下载当天（租户时区）2026-12-05，改名自 2026-12-01 起生效。 */
  const LATER = '2026-12-05T02:00:00.000Z';
  const RENAMED_ON = '2026-12-01';

  it('生效日之后改名：文件名用当前名（多个组织按选择顺序以“、”连接，日期是下载当天）；卡片内仍是生效日旧名；两态同名', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const s = uniqueSuffix();
    const [oldA, oldB] = [await orgName(w, w.a), await orgName(w, w.b)];
    await renameFrom(w, w.a, `ZZ_甲现名${s}`, RENAMED_ON);
    await renameFrom(w, w.b, `ZZ_乙现名${s}`, RENAMED_ON);
    const view = await w.created(w.head({ adjustmentRange: [w.b, w.a] }));
    w.setNow(LATER);

    const before = await exported(w, view.id, false);
    const after = await exported(w, view.id, true);
    expect(before.fileName).toBe(`架构图（ZZ_乙现名${s}、ZZ_甲现名${s}）_20261205`);
    expect(after.fileName).toBe(before.fileName);
    for (const result of [before, after]) {
      expect(nodes(result.svg).map((texts) => texts[0])).toEqual([oldB, oldA]);
      expect(result.svg).not.toContain(`ZZ_甲现名${s}`);
      expect(result.fileName).not.toContain(oldA);
    }
  });

  it('尚未到改名生效日时文件名仍是改名前的名称；没有可见调整范围时为“--”', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const s = uniqueSuffix();
    const oldA = await orgName(w, w.a);
    await renameFrom(w, w.a, `ZZ_甲现名${s}`, '2027-03-01');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    w.setNow(LATER);
    expect((await exported(w, view.id, false)).fileName).toBe(`架构图（${oldA}）_20261205`);

    w.access.hiddenFields = new Set(['adjustmentRange']);
    expect((await exported(w, view.id, false)).fileName).toBe('架构图（--）_20261205');
  });

  it('调整明细 / 详情头部的审批主体组织名仍按生效日取名（北森明细文字保留旧名）；“调整前”导出仍可用', async () => {
    const w = await itemsWorld(testDb().db, 'oa44');
    const oldSubject = await orgName(w, w.subject);
    await renameFrom(w, w.subject, `ZZ_主体现名${uniqueSuffix()}`, RENAMED_ON);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await w.item(view.id, newOrg(w.a, { name: `ZZ_新${uniqueSuffix()}` }));
    w.setNow(LATER);

    const detail = await w.call('GET', `${BASE}/${view.id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(((await detail.json()) as { approvalSubjectOrgName: string }).approvalSubjectOrgName).toBe(oldSubject);
    const before = await exported(w, view.id, false);
    expect(nodes(before.svg).map((texts) => texts[1])).toEqual(expect.arrayContaining(['新增']));
  });
});
