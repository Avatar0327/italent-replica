/** AC-QL-chart-export：真实授权器与实际下载文件；QL-R12、设计 §5.1 / §5.3、DEC-067 / 352。 */
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, type Data, operator, seed } from './AC-QL-perm-support.js';
import { QL_NOW } from './AC-QL-support.js';
import { qualificationWorld } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const path = (ids: readonly string[]) => `/chart-export?categoryIds=${ids.join(',')}`;

// 从 ZIP 目录独立读出文件，不依赖生产打包器；同时覆盖 xlsx 内部 ZIP 与多选外层 ZIP。
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return files;
}
const unescape = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function chartOf(bytes: Buffer) {
  const files = unzip(bytes);
  expect(files.has('[Content_Types].xml')).toBe(true);
  const xml = files.get('xl/worksheets/sheet1.xml')!.toString();
  const rows = [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((match) =>
    [...match[1]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((cell) => unescape(cell[1]!)),
  );
  const chart: { standardId?: string; levels: Record<string, unknown>[] } = { levels: [] };
  for (const [field, meta, ...levels] of rows.slice(1)) {
    if (field === 'standardId') chart.standardId = JSON.parse(meta!);
    else if (field === 'levels') chart.levels = JSON.parse(meta!);
    else
      levels.forEach((value, index) => {
        if (!value) return;
        chart.levels[index] ??= {};
        const parts = field!.split('/');
        let node: Record<string, unknown> = chart.levels[index]!;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = parts[i]!;
          node[key] ??= /^\d+$/.test(parts[i + 1]!) ? [] : {};
          node = node[key] as Record<string, unknown>;
        }
        node[parts.at(-1)!] = JSON.parse(value);
      });
  }
  return chart;
}

async function download(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('attachment;');
  expect(response.headers.get('cache-control')).toBe('no-store');
  return Buffer.from(await response.arrayBuffer());
}

async function error(response: Response, status: number, reason?: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.error.code).toBe(status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED');
  if (reason) expect(body.error.details.reason).toBe(reason);
  return body;
}

describe('AC-QL-chart-export 图谱导出', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
  });

  it('单选 xlsx 与查看接口全部可见字段逐项一致，保留中文、引号、XML 与公式样式文本', async () => {
    const create = await data.adminIn(data.parent);
    const category = await create<{ id: string }>('/categories', {
      classId: data.open.classId,
      code: code(),
      name: '导出类',
    });
    const standard = await create<{ id: string }>('/standards', {
      categoryId: category.id,
      name: '导出标准',
      levelIds: [data.levelId],
      details: [{ levelId: data.levelId, targetId: data.plainTarget, abilities: [{ content: '=中文<"&>\n标准' }] }],
      levelDescriptions: [{ levelId: data.levelId, description: '级别描述' }],
    });
    const op = await operator(world, { mouId: data.childMou });
    const view = await (await op.request('GET', `/standards/${standard.id}/chart`)).json();
    const response = await op.request('GET', path([category.id.toUpperCase()]));
    expect(response.headers.get('content-type')).toContain('spreadsheetml.sheet');
    const bytes = await download(response);
    expect(chartOf(bytes)).toEqual(view);
    expect(JSON.stringify(chartOf(bytes))).toContain('中文');
    expect(unzip(bytes).get('xl/worksheets/sheet1.xml')!.toString()).not.toContain('<f>');
  });

  it('多选每类别一个 xlsx，隐藏明细、级别描述与顺序号的字段名和值都不出现', async () => {
    const op = await operator(world, {
      hidden: { standard: ['details', 'levelDescriptions'], level: ['displayOrder'] },
    });
    const response = await op.request('GET', path([data.open.id, data.closed.id]));
    expect(response.headers.get('content-type')).toContain('application/zip');
    const files = unzip(await download(response));
    expect([...files.keys()]).toEqual([`${data.open.id}.xlsx`, `${data.closed.id}.xlsx`]);
    const shown = chartOf(files.get(`${data.open.id}.xlsx`)!);
    expect(shown).toEqual(await (await op.request('GET', `/standards/${data.standardId}/chart`)).json());
    const xml = unzip(files.get(`${data.open.id}.xlsx`)!)
      .get('xl/worksheets/sheet1.xml')!
      .toString();
    for (const value of ['cells', 'description', 'displayOrder', '通用保密说明']) expect(xml).not.toContain(value);
    expect(chartOf(files.get(`${data.closed.id}.xlsx`)!)).toEqual({ levels: [] });
  });

  it('通用指标说明隐藏时省略覆盖能力标准内容，与查看接口的 projectionHidden 一致', async () => {
    const op = await operator(world, { hidden: { target: ['description'] } });
    const bytes = await download(await op.request('GET', path([data.open.id])));
    const shown = chartOf(bytes);
    expect(shown).toEqual(await (await op.request('GET', `/standards/${data.standardId}/chart`)).json());
    expect(JSON.stringify(shown)).toContain('projectionHidden');
    const xml = unzip(bytes).get('xl/worksheets/sheet1.xml')!.toString();
    expect(xml).not.toContain('通用保密说明');
    expect(xml).not.toContain('/content');
  });

  it('级别范围隐藏时导出空级别，同查看投影；撤权后重新下载不保留旧字段', async () => {
    const op = await operator(world, { mouId: data.parentMou });
    await download(await op.request('GET', path([data.open.id])));
    await op.hide('standard', ['levelIds']);
    const bytes = await download(await op.request('GET', path([data.open.id])));
    expect(chartOf(bytes)).toEqual(await (await op.request('GET', `/standards/${data.standardId}/chart`)).json());
    expect(bytes.toString()).not.toContain(data.levelId);
    expect(chartOf(bytes).levels).toEqual([]);
  });

  it('无标准对象查看权限 403；无管理范围与管理单元外仍遵循 DEC-352 同查看规则', async () => {
    const denied = await operator(world, { noObject: ['standard'] });
    await error(await denied.request('GET', path([data.open.id])), 403);
    const op = await operator(world, {});
    const bytes = await download(await op.request('GET', path([data.open.id])));
    expect(chartOf(bytes)).toEqual(await (await op.request('GET', `/standards/${data.standardId}/chart`)).json());
  });

  it('多选含不存在、跨租户类别与单选不存在一律同 404，无部分文件或类别编号披露', async () => {
    const foreign = await qualificationWorld(world.db, 'chart-export-foreign');
    const klass = await foreign.categoryClass();
    const category = await foreign.category(klass.id);
    const op = await operator(world, {});
    const missing = randomUUID();
    const before = await (await op.request('GET', `/standards/${data.standardId}/chart`)).json();
    const first = await error(await op.request('GET', path([missing])), 404);
    for (const ids of [
      [data.open.id, missing],
      [data.open.id, category.id],
    ]) {
      expect(await error(await op.request('GET', path(ids)), 404)).toEqual(first);
    }
    expect(await (await op.request('GET', `/standards/${data.standardId}/chart`)).json()).toEqual(before);
  });

  it('20 类别允许，21 类别明确拒绝；重复和空选择、非法 UUID 拒绝', async () => {
    const create = await data.adminIn(data.parent);
    const ids = [data.open.id];
    for (let i = 1; i < 20; i++)
      ids.push(
        (
          await create<{ id: string }>('/categories', {
            classId: data.open.classId,
            code: code(),
            name: `边界类${i}`,
          })
        ).id,
      );
    const op = await operator(world, {});
    expect(unzip(await download(await op.request('GET', path(ids)))).size).toBe(20);
    await error(await op.request('GET', path([...ids, randomUUID()])), 400, 'EXPORT_CATEGORY_LIMIT');
    for (const ids of [[], ['not-a-uuid'], [data.open.id, data.open.id.toUpperCase()]]) {
      await error(await op.request('GET', path(ids)), 400);
    }
  });

  it('多选按整批累计 Excel 行数，各文件未超限但整批超限仍拒绝', async () => {
    const sample = await qualificationWorld(world.db, 'chart-export-row-total');
    const klass = await sample.categoryClass();
    const level = await sample.level(1);
    const type = await sample.targetType();
    const categories = [];
    for (let i = 0; i < 3; i++) {
      const category = await sample.category(klass.id);
      categories.push(category.id);
      const standard = await sample.standard({ categoryId: category.id, levelIds: [level.id], details: [] });
      await withTenant(world.db, sample.tenant.id, async (tx) => {
        await tx.execute(sql`INSERT INTO ql_targets
          (id, tenant_id, type_id, owner_id, owner_org_id, created_by, code, name, eval_mode)
          SELECT gen_random_uuid(), ${sample.tenant.id}::uuid, ${type.id}::uuid,
            ${sample.user.id}::uuid, ${sample.orgId}::uuid, ${sample.user.id}::uuid,
            ${`batch${i}-`} || n, '累计行数指标', 'score'
          FROM generate_series(1,300) n`);
        await tx.execute(sql`INSERT INTO ql_standard_details (id, tenant_id, standard_id, level_id, target_id)
          SELECT gen_random_uuid(), tenant_id, ${standard.id}::uuid, ${level.id}::uuid, id
          FROM ql_targets WHERE tenant_id = ${sample.tenant.id}::uuid AND code LIKE ${`batch${i}-%`}`);
        await tx.execute(sql`INSERT INTO ql_ability_details (id, tenant_id, detail_id, content, source)
          SELECT gen_random_uuid(), tenant_id, id, '累计行数能力', 'manual'
          FROM ql_standard_details WHERE tenant_id = ${sample.tenant.id}::uuid AND standard_id = ${standard.id}::uuid`);
      });
    }
    await download(await sample.request('GET', path([categories[0]!])));
    await error(await sample.request('GET', path(categories)), 400, 'EXPORT_ROW_LIMIT');
  });

  it('超 10000 数据行在组装前拒绝，不截断输出', async () => {
    const op = await operator(world, {});
    await withTenant(world.db, world.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO ql_ability_details
        (id, tenant_id, detail_id, content, display_order, source)
        SELECT gen_random_uuid(), ${world.tenant.id}::uuid, d.id, '上限样本', n, 'manual'
        FROM ql_standard_details d CROSS JOIN generate_series(1,10001) n
        WHERE d.tenant_id = ${world.tenant.id}::uuid AND d.standard_id = ${data.standardId}::uuid`);
    });
    try {
      await error(await op.request('GET', path([data.open.id])), 400, 'EXPORT_ROW_LIMIT');
    } finally {
      await withTenant(world.db, world.tenant.id, (tx) =>
        tx.execute(sql`DELETE FROM ql_ability_details
        WHERE tenant_id = ${world.tenant.id}::uuid AND content = '上限样本'`),
      );
    }
  });
});
