import { sql } from '@italent/db';
import { HR_MOVEMENT_OBJECT, HR_STRUCTURE_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { STRUCTURE_BASE, structureWorld, TODAY, type DetailPage } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE, MOVEMENT_TODAY, movementWorld } from './AC-HA-13b-support.js';
import { parseCsv } from './AC-HA-roster-support.js';
import type { RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const structure = { base: STRUCTURE_BASE, name: 'hr-structure', object: HR_STRUCTURE_OBJECT, asOf: TODAY };
const movement = { base: MOVEMENT_BASE, name: 'hr-movement', object: HR_MOVEMENT_OBJECT, asOf: MOVEMENT_TODAY };
const COLUMNS = ['明细行 ID', '员工 ID', '组织 ID'];
type Board = typeof structure | typeof movement;
type Read = (path: string, options?: RequestOptions) => Promise<Response>;

async function structureFixture() {
  const w = await structureWorld(database().db, 'f547-be2');
  const parent = await w.org('甲机构', undefined, '机构');
  const child = await w.org('乙机构', parent, '机构');
  const team = await w.org('甲小组', parent);
  const outside = await w.org('范围外机构', undefined, '机构');
  const hire = (name: string, department: { id: string }, educationLevel: string) =>
    w.hire(name, { date: '2026-01-01', department, profile: { educationLevel } });
  const bachelor = await hire('合成本科', parent, '本科');
  const master = await hire('合成硕士', parent, '硕士');
  const junior = await hire('合成专科', parent, '大专');
  const teamMember = await hire('合成组员', team, '本科');
  const childMember = await hire('合成子机构人员', child, '本科');
  const outsideMember = await hire('合成范围外人员', outside, '本科');
  return { w, parent, child, team, outside, bachelor, master, junior, teamMember, childMember, outsideMember };
}

let s: Awaited<ReturnType<typeof structureFixture>>;
let m: Awaited<ReturnType<typeof movementWorld>>;
beforeAll(async () => {
  s = await structureFixture();
  m = await movementWorld(database().db);
}, 600_000);

const readStructure: Read = (path, options) => s.w.call('GET', path, options);
const readMovement: Read = (path, options) => m.call('GET', path, options);
const detailPath = (board: Board, component: string) => `${board.base}/components/${component}`;
const date = (board: Board) => `asOf=${board.asOf}`;
const group = (key: string) => `group=${encodeURIComponent(key)}`;
const download = (board: Board, component: string, query = date(board)) =>
  `${detailPath(board, component)}/export?${query}`;

async function csv(response: Response, board: Board, code: string, asOf = board.asOf) {
  expect(response.status, `${board.name}/${code} 下载必须成功`).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${board.name}-${code}-${asOf}.csv"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const body = new TextDecoder().decode(bytes.slice(3));
  expect(body).toMatch(/\r\n$/);
  expect(body.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  return parseCsv(body);
}

async function detailRows(read: Read, board: Board, code: string, query: string) {
  const result: DetailPage['items'] = [];
  for (let page = 1; page <= 15; page++) {
    const response = await read(`${detailPath(board, code)}?${query}&page=${page}&pageSize=1`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { total, items } = (await response.json()) as DetailPage;
    result.push(...items);
    if (result.length === total) return result;
  }
  throw new Error('验收夹具明细超过 15 页');
}

function logs(tenantId: string, board: Board, code: string) {
  const w = tenantId === s.w.tenantId ? s.w : m.x;
  return w.sqlRows<{ id: string; behavior: string }>(sql`SELECT * FROM audit_operation_logs
    WHERE tenant_id=${tenantId} AND object_type=${board.object} AND object_id=${code} AND behavior='export'
    ORDER BY id`);
}

async function compareDetail(
  read: Read,
  board: Board,
  code: string,
  query: string,
  expected: readonly { id: string }[],
) {
  const rows = await detailRows(read, board, code, query);
  expect(rows.map(({ id }) => id).sort()).toEqual(expected.map(({ id }) => id).sort());
  const response = await read(download(board, code, query));
  expect(await csv(response.clone(), board, code)).toEqual([
    COLUMNS,
    ...rows.map(({ id, employeeId, organizationId }) => [id, employeeId ?? '', organizationId ?? '']),
  ]);
  return response;
}

it('AC-HA-F547-01/02/06 B49 两个含下级开关均为 false，6.11 只下载本科及以上分子并留痕', async () => {
  const code = '6.11';
  const query =
    `${date(structure)}&institutionId=${s.parent.id}&institutionIncludeChildren=false` +
    `&departmentId=${s.parent.id}&departmentIncludeChildren=false&${group(s.parent.id)}`;
  const before = await logs(s.w.tenantId, structure, code);
  await compareDetail(readStructure, structure, code, query, [s.bachelor, s.master]);
  const after = await logs(s.w.tenantId, structure, code);
  expect(after).toHaveLength(before.length + 1);
  expect(after).toContainEqual(
    expect.objectContaining({
      tenant_id: s.w.tenantId,
      actor_user_id: s.w.who.user,
      object_type: structure.object,
      object_id: code,
      behavior: 'export',
      success_count: 1,
      failure_count: 0,
    }),
  );
});

it('AC-HA-F547-01/02/06 B50 按离职生效月跨分页下载，行顺序与 D 相等并留痕', async () => {
  const code = '6.26';
  const query = `${date(movement)}&${group('exit:2026-04')}`;
  const before = await logs(m.tenantId, movement, code);
  await compareDetail(readMovement, movement, code, query, [m.p.m30, m.p.m31]);
  const after = await logs(m.tenantId, movement, code);
  expect(after).toHaveLength(before.length + 1);
  expect(after).toContainEqual(
    expect.objectContaining({
      tenant_id: m.tenantId,
      actor_user_id: m.who.user,
      object_type: movement.object,
      object_id: code,
      behavior: 'export',
      success_count: 1,
      failure_count: 0,
    }),
  );
});
