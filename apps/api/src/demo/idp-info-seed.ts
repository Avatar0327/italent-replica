import { listAll, type Json } from './client.js';
import { DEMO_ORGS } from './data.js';
import type { DemoWorld } from './world.js';

/** F-154 / DEC-525③：仅经公开租户 HTTP 路由；自然键先查后建，不修改已有记录。 */
export async function seedIdpInfo(world: DemoWorld): Promise<number> {
  const { call, admin } = world;
  const as = (path: string, method = 'GET', body?: unknown, revision?: number) =>
    call(admin, method, `/api/tenant/${path}`, body, revision);
  let written = 0;
  written += await seedIdpAccess(world);
  const person = (key: string) => {
    const id = world.employees.get(key);
    if (!id) throw new Error(`演示员工缺失：${key}`);
    return id;
  };
  const positionId = world.positions.get('platformEngineer');
  const orgId = world.orgs.get('platform')?.id;
  if (!positionId || !orgId) throw new Error('演示轮岗部门 / 职位缺失');
  const dates = (i: number) => ({ startDate: `2026-0${i + 1}-01`, endDate: `2026-0${i + 1}-28` });
  const employeeId = person('employeeA');
  const tutorEmployeeId = person('platformManager');
  const sets: { path: string; keys: string[]; rows: Json[] }[] = [
    {
      path: 'tutorships',
      keys: ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate'],
      rows: Array.from({ length: 5 }, (_, i) => ({ tutorEmployeeId, tuteeEmployeeId: employeeId, ...dates(i) })),
    },
    {
      path: 'careers',
      keys: ['employeeId', 'startDate', 'endDate'],
      rows: Array.from({ length: 4 }, (_, i) => ({
        employeeId,
        targetPositionId: positionId,
        strengths: i % 2 ? null : '演示：专业能力与协作',
        developmentItems: i % 2 ? null : '演示：拓展业务视野',
        ...dates(i),
      })),
    },
    {
      path: 'work-shifts',
      keys: ['employeeId', 'orgId', 'positionId', 'postId', 'startDate', 'endDate'],
      rows: Array.from({ length: 7 }, (_, i) => ({
        employeeId,
        orgId,
        positionId,
        postId: null,
        mentorEmployeeId: i % 2 ? null : tutorEmployeeId,
        ...dates(i),
      })),
    },
  ];
  for (const set of sets) {
    const existing = await listAll(call, admin, `/api/tenant/idp/${set.path}`);
    const key = (row: Json) => JSON.stringify(set.keys.map((k) => row[k] ?? null));
    const found = new Set(existing.map(key));
    for (const row of set.rows) {
      if (found.has(key(row))) continue;
      await as(`idp/${set.path}`, 'POST', row, 0);
      found.add(key(row));
      written++;
    }
  }
  return written;
}

async function seedIdpAccess(world: DemoWorld) {
  const { call, admin } = world;
  const as = (path: string, method = 'GET', body?: unknown, revision?: number) =>
    call(admin, method, `/api/tenant/${path}`, body, revision);
  let written = 0;
  const profiles = await listAll(call, admin, '/api/tenant/permission/profiles');
  const profile = profiles.find((p) => p.code === 'standard_idp_admin');
  if (!profile) throw new Error('演示 IDP 管理员身份缺失');
  const grants = await listAll(call, admin, `/api/tenant/permission/grants?userId=${admin}`);
  if (!grants.some((g) => g.profileId === profile.id && g.status !== 'revoked')) {
    await as('permission/grants', 'POST', { userId: admin, profileId: profile.id });
    written++;
  }
  const scopePath = `permission/scopes/${admin}/IDP`;
  const scope = await as(scopePath);
  if (scope.kind === 'default') {
    const units = await listAll(call, admin, '/api/tenant/permission/mous');
    let unit = units.find((u) => u.code === 'DEMO-IDP');
    if (!unit) {
      unit = await as(
        'permission/mous',
        'POST',
        {
          code: 'DEMO-IDP',
          name: '演示人才发展管理单元',
          orgRanges: DEMO_ORGS.filter((o) => !o.parent).map((o) => ({
            orgId: world.orgs.get(o.key)!.id,
            includeDescendants: true,
          })),
        },
        0,
      );
      written++;
    }
    await as(scopePath, 'PUT', { kind: 'mou', mouId: unit.id }, Number(scope.revision));
    written++;
  }
  return written;
}
