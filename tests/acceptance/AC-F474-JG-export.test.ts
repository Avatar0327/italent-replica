/**
 * F-474-7c 职务职级图谱与待确认记录的 xlsx 导出（设计 docs/08_设计/F-474-7a_职务职级图谱_设计.md §1、§4.2、§5；
 * DEC-896 U4 / U7 = A）。期望值手写：真解压文件，逐格核对工作表名、合并区、样式（底色 / 细边框 / 居中 / Calibri 11）
 * 与内联字符串内容；不拿被测写入器当参照。授权部分见 AC-F474-JG-access。
 */
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { buildJobGraph } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { GRAPH, GRAPH_NOW, graphInput, graphWorld, record, seedGraph } from './support/job-graph.js';
import { tenantApi } from './support/tenant-api.js';
import { readXlsx, valueAt, type Xlsx } from './support/xlsx-read.js';

const testDb = useTestDb();
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function download(response: Response) {
  expect(response.status, response.status === 200 ? '' : await response.clone().text()).toBe(200);
  expect(response.headers.get('content-type')).toBe(XLSX);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return Buffer.from(await response.arrayBuffer());
}
/** 错误响应：机器码 + details.reason，且没有任何文件头 / 文件字节。 */
async function failure(response: Response, status: number, code: string, reason?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  expect(body.error.code).toBe(code);
  if (reason) expect(body.error.details?.reason).toBe(reason);
}
const fileName = (response: Response) => {
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1];
  return encoded ? decodeURIComponent(encoded) : undefined;
};

interface CellStyle {
  fill?: string;
  border: string[];
  horizontal?: string;
  vertical?: string;
  font: string;
}
/** 读 styles.xml：单元格 s → cellXfs → 填充色 / 四边边框颜色 / 对齐 / 字体（手写解析，不依赖被测实现）。 */
function stylesOf(book: Xlsx) {
  const styles = book.entries.get('xl/styles.xml');
  expect(styles, '缺 styles.xml').toBeDefined();
  const list = (tag: string, item: string) =>
    [
      ...(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(styles!)?.[1] ?? '').matchAll(
        new RegExp(`<${item}\\b[^>]*?(?:/>|>[\\s\\S]*?</${item}>)`, 'g'),
      ),
    ].map((m) => m[0]);
  const fonts = list('fonts', 'font');
  const fills = list('fills', 'fill');
  const borders = list('borders', 'border');
  const xfs = list('cellXfs', 'xf');
  const attr = (text: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(text)?.[1];
  const sheet = book.entries.get('xl/worksheets/sheet1.xml')!;
  return (ref: string): CellStyle => {
    const cell = new RegExp(`<c r="${ref}"[^>]*>`).exec(sheet)?.[0];
    expect(cell, `缺单元格 ${ref}`).toBeDefined();
    const xf = xfs[Number(attr(cell!, 's') ?? 0)]!;
    const fill = fills[Number(attr(xf, 'fillId') ?? 0)]!;
    const border = borders[Number(attr(xf, 'borderId') ?? 0)]!;
    const font = fonts[Number(attr(xf, 'fontId') ?? 0)]!;
    const solid = /patternType="solid"/.test(fill) ? /<fgColor rgb="([0-9A-F]{8})"/.exec(fill)?.[1] : undefined;
    return {
      fill: solid,
      border: ['left', 'right', 'top', 'bottom'].map((side) => {
        const edge = new RegExp(`<${side} style="([a-z]+)"><color rgb="([0-9A-F]{8})"/></${side}>`).exec(border);
        return edge ? `${edge[1]} ${edge[2]}` : 'none';
      }),
      horizontal: attr(/<alignment[^>]*>/.exec(xf)?.[0] ?? '', 'horizontal'),
      vertical: attr(/<alignment[^>]*>/.exec(xf)?.[0] ?? '', 'vertical'),
      font: `${attr(/<name [^>]*>/.exec(font)?.[0] ?? '', 'val')} ${attr(/<sz [^>]*>/.exec(font)?.[0] ?? '', 'val')}${
        /<b\/>/.test(font) ? ' bold' : ''
      }`,
    };
  };
}
const THIN = Array(4).fill('thin FFE6E8EB');

describe('AC-F474-JG-08 图谱导出', () => {
  it('无快照 409 GRAPH_NOT_GENERATED（U4=A），不生成文件；导出不写快照', async () => {
    const w = await graphWorld(testDb().db);
    await failure(await w.api.request('GET', `${GRAPH}/export`, w.as), 409, 'CONFLICT', 'GRAPH_NOT_GENERATED');
    expect(await (await w.api.request('GET', GRAPH, w.as)).json()).toEqual({ snapshot: null });
  });

  it('文件名按租户时区的导出时刻；单 Sheet0；合并区、底色、细边框、居中、Calibri 11 与页面同一快照', async () => {
    const w = await graphWorld(testDb().db);
    expect((await w.rebuild()).status).toBe(200);
    const response = await w.api.request('GET', `${GRAPH}/export`, w.as);
    // GRAPH_NOW = 2026-11-12T02:30:00Z，租户 America/Chicago（CST，UTC-6）→ 2026-11-11 20:30:00
    expect(fileName(response)).toBe('职务职级图谱_20261111203000.xlsx');
    const book = readXlsx(await download(response));
    expect(book.sheetNames).toEqual(['Sheet0']);
    // 快照（support/job-graph.ts graphInput）：职等 g3 > g2 > g1；类别 t；职级 l 跨 g1～g2；序列 s / child；职务 p 落 l 的两行
    const expected: Record<string, string> = {
      A1: '职等',
      B1: '职级',
      C1: 's',
      B2: 't',
      C2: 'child',
      A3: 'g3',
      A4: 'g2',
      A5: 'g1',
      B4: 'l',
      C4: 'p',
      C5: 'p',
    };
    for (const [ref, value] of Object.entries(expected)) expect(valueAt(book, ref), ref).toBe(value);
    for (const ref of ['A2', 'B3', 'C3', 'B5']) expect(valueAt(book, ref) ?? '', ref).toBe('');
    expect(book.merges.sort()).toEqual(['A1:A2', 'B4:B5']);
    const sheet = book.entries.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toMatch(/t="s"|t="str"/);
    expect([...sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*t="inlineStr"/g)].length).toBe(Object.keys(expected).length);
    const style = stylesOf(book);
    const fills: Record<string, string | undefined> = {
      A1: 'FFF0F2F5',
      A2: 'FFF0F2F5',
      B1: 'FFF0F2F5',
      C1: 'FFF0F2F5',
      B2: 'FFEAF5FF',
      C2: 'FFFAFAFB',
      A3: 'FFFFFFFF',
      A4: 'FFFFFFFF',
      A5: 'FFFFFFFF',
      B3: undefined,
      C3: undefined,
      B4: 'FFEAF5FF',
      B5: 'FFEAF5FF',
      C4: 'FFEAF5FF',
      C5: 'FFEAF5FF',
    };
    for (const [ref, fill] of Object.entries(fills)) {
      expect(style(ref), ref).toEqual({
        fill,
        border: THIN,
        horizontal: 'center',
        vertical: 'center',
        font: 'Calibri 11',
      });
    }
    expect(book.entries.get('[Content_Types].xml')).toContain('/xl/styles.xml');
    expect(book.entries.get('xl/_rels/workbook.xml.rels')).toContain('styles.xml');
    expect(book.entries.get('xl/styles.xml')).not.toContain('FFAB24');
  });

  it('多个职级类别按 colorKey 轮换三种类别色；列头横向合并与序列多级表头沿用快照 merges', async () => {
    const input = graphInput();
    input.levelTypes.push(record('t2'), record('t3'), record('t4'));
    input.levels.push(
      record('l2', { levelTypeId: 't2', minGradeId: 'g3', maxGradeId: 'g3' }),
      record('l3', { levelTypeId: 't3', minGradeId: 'g3', maxGradeId: 'g3' }),
      record('l4', { levelTypeId: 't4', minGradeId: 'g3', maxGradeId: 'g3' }),
    );
    const w = await graphWorld(testDb().db, input);
    expect((await w.rebuild()).status).toBe(200);
    const book = readXlsx(await download(await w.api.request('GET', `${GRAPH}/export`, w.as)));
    // 列：A 职等，B～E 类别 t / t2 / t3 / t4（按名称排序），F 序列 s / child
    expect(['B2', 'C2', 'D2', 'E2', 'F1', 'F2'].map((ref) => valueAt(book, ref))).toEqual([
      't',
      't2',
      't3',
      't4',
      's',
      'child',
    ]);
    expect(book.merges.sort()).toEqual(['A1:A2', 'B1:E1', 'B4:B5']);
    const style = stylesOf(book);
    expect(['B2', 'C2', 'D2', 'E2', 'C3', 'D3', 'E3'].map((ref) => style(ref).fill)).toEqual([
      'FFEAF5FF',
      'FFFEF8E5',
      'FFF2FAE7',
      'FFEAF5FF',
      'FFFEF8E5',
      'FFF2FAE7',
      'FFEAF5FF',
    ]);
    // 被横向合并覆盖的 C1～E1 也带锚点格的底色与边框，合并区四周边框完整
    for (const ref of ['C1', 'D1', 'E1']) expect(style(ref)).toMatchObject({ fill: 'FFF0F2F5', border: THIN });
  });

  it('导出读当前快照、不现算：改源数据不重新生成，导出不变；重新生成后才变；不规范数据不进图谱文件', async () => {
    const input = graphInput();
    input.posts.push(record('loose', { name: '合成无序列', minLevelId: 'l' }));
    const w = await graphWorld(testDb().db, input);
    expect((await w.rebuild()).status).toBe(200);
    const values = async () =>
      [...readXlsx(await download(await w.api.request('GET', `${GRAPH}/export`, w.as))).cells.values()].map(
        (cell) => cell.value,
      );
    const first = await values();
    expect(first).toContain('p');
    expect(first).not.toContain('合成无序列');
    // 版本表只增不改：加一个新职等作为“源数据变化”
    const extra = { grades: [record('g9', { name: '合成新职等', grade: 9 })], levelTypes: [], levels: [] };
    await seedGraph(testDb().db, w.tenant.id, { ...extra, sequences: [], posts: [] });
    expect(await values()).toEqual(first);
    expect((await w.rebuild(1)).status).toBe(200);
    const next = await values();
    expect(next).toContain('合成新职等');
    expect(next).not.toContain('合成无序列');
  });

  it('文本防公式注入与转义：= 开头仍是内联字符串，_xHHHH_ 与 XML 1.0 禁止字符按 R3-T02 规则编码', async () => {
    const input = graphInput();
    input.posts[0] = { ...input.posts[0]!, name: '=1+1<&>"_x0041_\u0001\uFFFE' };
    const w = await graphWorld(testDb().db, input);
    expect((await w.rebuild()).status).toBe(200);
    const bytes = await download(await w.api.request('GET', `${GRAPH}/export`, w.as));
    const book = readXlsx(bytes);
    expect(valueAt(book, 'C4')).toBe('=1+1<&>"\\u005fx0041_\\u0001\\ufffe');
    const sheet = book.entries.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).not.toContain('<f>');
    const forbidden = [...sheet].filter((ch) => {
      const code = ch.codePointAt(0)!;
      return (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0xfffe || code === 0xffff;
    });
    expect(forbidden).toEqual([]);
    expect(sheet).toContain('<c r="C4" s="');
  });

  it('超限整单 400（EXPORT_ROW_LIMIT），不给半份文件；租户隔离：别的租户的快照不可导出', async () => {
    const w = await graphWorld(testDb().db);
    const grades = Array.from({ length: 10_001 }, (_, i) => record(`g${i}`, { grade: i + 1 }));
    const layout = buildJobGraph({ grades, levelTypes: [], levels: [], sequences: [], posts: [] }).layout;
    await withTenant(testDb().db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO job_graph_snapshots (tenant_id, revision, generated_at, generated_by, as_of_date,
        contains_error, empty, issue_count, layout) VALUES (${w.tenant.id}, 1, '2026-11-12T02:30:00Z', ${w.user.id},
        '2026-11-11', false, true, 0, ${JSON.stringify(layout)}::jsonb)`),
    );
    await failure(await w.api.request('GET', `${GRAPH}/export`, w.as), 400, 'VALIDATION_FAILED', 'EXPORT_ROW_LIMIT');
    const other = await graphWorld(testDb().db);
    await failure(await other.api.request('GET', `${GRAPH}/export`, other.as), 409, 'CONFLICT', 'GRAPH_NOT_GENERATED');
  });
});

/** 照重新生成的写法整表替换待确认记录：先删后插 count 条（合成名称）。 */
const fillIssues = async (tx: Tx, tenantId: string, count: number) => {
  await tx.execute(sql`DELETE FROM job_graph_issues WHERE tenant_id = ${tenantId}`);
  await tx.execute(sql`INSERT INTO job_graph_issues (tenant_id, kind, object_id, object_name, reasons, sort_key)
    SELECT ${tenantId}::uuid, 'post', gen_random_uuid(), '合成职务' || g,
      '[{"code":"POST_SEQUENCE_EMPTY","params":[]}]'::jsonb, g FROM generate_series(1, ${count}::int) g`);
};

/**
 * 在导出的“数量检查”与“取数”两条语句之间插入一步（P2-1 交错）。数量检查的结果只有一行一列 total，
 * 按结果外形识别、不看 SQL 原文；只触发一次。
 */
function pauseAfterCount(db: Db, between: (tx: Tx) => Promise<void>) {
  const state = { fired: false };
  const passThrough = (target: object, key: string | symbol) => {
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };
  const wrap = (tx: Tx) =>
    new Proxy(tx, {
      get: (target, key) =>
        key !== 'execute'
          ? passThrough(target, key)
          : async (query: Parameters<Tx['execute']>[0]) => {
              const result = await target.execute(query);
              const rows = rowsOf<Record<string, unknown>>(result);
              if (!state.fired && rows.length === 1 && Object.keys(rows[0]!).join() === 'total') {
                state.fired = true;
                await between(target);
              }
              return result;
            },
    });
  const proxied = new Proxy(db, {
    get: (target, key) =>
      key !== 'transaction'
        ? passThrough(target, key)
        : (fn: (tx: Tx) => Promise<unknown>, config?: Parameters<Db['transaction']>[1]) =>
            target.transaction((tx) => fn(wrap(tx)), config),
  });
  return { db: proxied, state };
}

describe('AC-F474-JG-09 待确认记录导出', () => {
  const ISSUES = `${GRAPH}/issues`;
  async function issuesWorld() {
    const input = graphInput();
    input.posts.push(...Array.from({ length: 18 }, (_, i) => record(`bad${i}`, { name: `异常职务${i}` })));
    input.levels.push(record('bad', { name: '合成空职级', levelTypeId: 't' }));
    const w = await graphWorld(testDb().db, input);
    expect((await w.rebuild()).status).toBe(200);
    const list = (await (await w.api.request('GET', `${ISSUES}?pageSize=100`, w.as)).json()) as {
      items: { kind: string; objectId: string; objectName: string }[];
    };
    return { w, items: list.items };
  }
  const exported = async (w: Awaited<ReturnType<typeof graphWorld>>, query: string) => {
    const response = await w.api.request('GET', `${ISSUES}/export?${query}`, w.as);
    const book = readXlsx(await download(response));
    return { response, book, rows: [...new Set([...book.cells.keys()].map((ref) => Number(ref.slice(1))))] };
  };

  it('导出全部：单 Sheet0，列“类型｜名称｜无法生成图谱原因”，顺序与列表一致，原因按资源文件串接', async () => {
    const { w, items } = await issuesWorld();
    const { response, book, rows } = await exported(w, 'all=true');
    expect(fileName(response)).toBe('待确认的职务职级记录_20261111203000.xlsx');
    expect(book.sheetNames).toEqual(['Sheet0']);
    expect(rows).toHaveLength(1 + 19);
    expect(['A1', 'B1', 'C1', 'D1'].map((ref) => valueAt(book, ref))).toEqual([
      '类型',
      '名称',
      '无法生成图谱原因',
      undefined,
    ]);
    expect(['A2', 'B2', 'C2'].map((ref) => valueAt(book, ref))).toEqual(['职级', '合成空职级', '该职级的职等范围为空']);
    expect(['A3', 'B3', 'C3'].map((ref) => valueAt(book, ref))).toEqual([
      '职务',
      items[1]!.objectName,
      '该职务的职级范围为空；该职务的职务序列为空',
    ]);
    expect(items.map((_, i) => valueAt(book, `B${i + 2}`))).toEqual(items.map((item) => item.objectName));
    expect(book.entries.get('xl/worksheets/sheet1.xml')).not.toContain('<f>');
  });

  it('导出已选按对象 ID；全部带当前筛选；参数非法整单 400', async () => {
    const { w, items } = await issuesWorld();
    const picked = [items[5]!, items[2]!];
    const selected = await exported(w, `ids=${picked.map((item) => item.objectId).join(',')}`);
    // 按列表顺序输出，不按勾选顺序
    expect(['B2', 'B3', 'B4'].map((ref) => valueAt(selected.book, ref))).toEqual([
      items[2]!.objectName,
      items[5]!.objectName,
      undefined,
    ]);
    const filtered = await exported(w, `all=true&kind=post&name=${encodeURIComponent('异常职务1')}`);
    // 异常职务1、异常职务10～17
    expect(filtered.rows).toHaveLength(1 + 9);
    expect((await exported(w, 'all=true&kind=level')).rows).toHaveLength(2);
    const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID()).join(',');
    expect((await exported(w, `ids=${ids(500)}`)).rows).toHaveLength(1);
    for (const query of ['', 'all=false', `all=true&ids=${items[0]!.objectId}`, `ids=${ids(501)}`, 'ids=not-a-uuid']) {
      await failure(await w.api.request('GET', `${ISSUES}/export?${query}`, w.as), 400, 'VALIDATION_FAILED');
    }
  });

  it('上限 10000 条：正好 10000 可导出，超出整单 400（EXPORT_ROW_LIMIT）', async () => {
    const w = await graphWorld(testDb().db);
    const seed = (count: number) =>
      withTenant(testDb().db, w.tenant.id, async (tx) => {
        await tx.execute(sql`DELETE FROM job_graph_issues WHERE tenant_id = ${w.tenant.id}`);
        await tx.execute(sql`INSERT INTO job_graph_issues (tenant_id, kind, object_id, object_name, reasons, sort_key)
          SELECT ${w.tenant.id}::uuid, 'post', gen_random_uuid(), '合成职务' || g,
            '[{"code":"POST_SEQUENCE_EMPTY","params":[]}]'::jsonb, g FROM generate_series(1, ${count}::int) g`);
      });
    await seed(10_000);
    expect((await exported(w, 'all=true')).rows).toHaveLength(10_001);
    await seed(10_001);
    await failure(
      await w.api.request('GET', `${ISSUES}/export?all=true`, w.as),
      400,
      'VALIDATION_FAILED',
      'EXPORT_ROW_LIMIT',
    );
  });

  it('数量检查通过后、取数前有人重新生成出 10001 条：整单 400（EXPORT_ROW_LIMIT），不静默截断成 10000 条', async () => {
    const w = await graphWorld(testDb().db);
    await withTenant(testDb().db, w.tenant.id, (tx) => fillIssues(tx, w.tenant.id, 10_000));
    // 真 PG：另一连接提交，READ COMMITTED 下导出的下一条语句可见；PGlite 只有一个连接，
    // 在导出事务里写入，对下一条语句的可见性相同。
    const committed = Boolean(process.env.TEST_DATABASE_URL);
    const paused = pauseAfterCount(testDb().db, (tx) =>
      committed
        ? withTenant(testDb().db, w.tenant.id, (other) => fillIssues(other, w.tenant.id, 10_001))
        : fillIssues(tx, w.tenant.id, 10_001),
    );
    const api = tenantApi(paused.db, { clock: () => GRAPH_NOW });
    const response = await api.request('GET', `${ISSUES}/export?all=true`, w.as);
    expect(paused.state.fired).toBe(true);
    await failure(response, 400, 'VALIDATION_FAILED', 'EXPORT_ROW_LIMIT');
  });
});
