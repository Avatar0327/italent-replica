import type { Page } from '@playwright/test';
import { employee, user } from './fixtures.js';
import { mockIdp, orgId, otherEmployee, type IdpMockOptions } from './r3d2-fixtures.js';

export const infoId = 'c1540000-0000-4000-8000-000000000001';
export const positionId = 'c1540000-0000-4000-8000-000000000099';
export const baseInfo = { id: infoId, revision: 1, createdBy: user, startDate: '2026-10-01', endDate: '2026-12-31' };
export const infoRows = {
  tutorships: { ...baseInfo, tutorEmployeeId: otherEmployee, tuteeEmployeeId: employee, remark: null },
  careers: {
    ...baseInfo,
    employeeId: employee,
    targetPositionId: positionId,
    strengths: '合成优势',
    developmentItems: null,
    intendedCity: null,
  },
  'work-shifts': {
    ...baseInfo,
    employeeId: employee,
    orgId,
    positionId,
    postId: null,
    mentorEmployeeId: otherEmployee,
  },
};
export type InfoKind = keyof typeof infoRows;
export async function mockInfo(
  page: Page,
  options: IdpMockOptions & { invalidReceipt?: boolean; personError?: boolean } = {},
) {
  await mockIdp(page, options);
  const calls: { method: string; path: string; body: Record<string, unknown>; revision: string | undefined }[] = [];
  const rows: Record<string, Record<string, unknown>[]> = Object.fromEntries(
    Object.entries(infoRows).map(([key, row]) => [
      key,
      Array.from({ length: key === 'tutorships' ? 5 : key === 'careers' ? 4 : 7 }, (_, i) => ({
        ...row,
        id: `c1540000-0000-4000-8000-00000000000${i + 1}`,
        startDate: `2026-10-0${i + 1}`,
      })),
    ]),
  );
  const codes: Record<string, string> = {
    tutorships: 'IDP.TutorShip',
    careers: 'IDP.Career',
    'work-shifts': 'IDP.WorkShift',
  };
  const trim = (kind: string, row: Record<string, unknown>) => {
    const fields = options.fields?.[codes[kind]!]?.viewable;
    return fields
      ? Object.fromEntries(
          Object.entries(row).filter(([key]) => ['id', 'revision', 'createdBy'].includes(key) || fields.includes(key)),
        )
      : row;
  };
  await page.route(/\/api\/tenant\/idp\/(tutorships|careers|work-shifts)(\/|\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const [kind, id] = path.split('/').slice(4) as [string, string | undefined];
    const collection = rows[kind]!;
    const row = collection.find((r) => r.id === id);
    if (request.method() === 'GET')
      return route.fulfill({
        json: id
          ? trim(kind, row!)
          : { items: collection.map((r) => trim(kind, r)), page: 1, pageSize: 200, hasDataPermission: true },
      });
    const call = {
      method: request.method(),
      path,
      body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
      revision: request.headers()['if-match'],
    };
    calls.push(call);
    const status = calls.length <= (options.conflictTimes ?? 0) ? 409 : options.writeStatus;
    if (status) {
      if (status === 409 && row) Object.assign(row, { revision: Number(row.revision) + 1, endDate: '2027-06-30' });
      return route.fulfill({ status, json: { error: { code: status === 409 ? 'REVISION_CONFLICT' : 'INTERNAL' } } });
    }
    if (options.invalidReceipt) return route.fulfill({ json: { id, revision: 1 } });
    if (call.method === 'DELETE') {
      rows[kind] = collection.filter((r) => r !== row);
      return route.fulfill({ json: row }); // 真实 DELETE 返回删除前快照，revision 不增加。
    }
    const result = {
      ...(row ?? baseInfo),
      ...call.body,
      id: id ?? 'c1540000-0000-4000-8000-000000000010',
      revision: row ? Number(row.revision) + 1 : 1,
    };
    if (row) Object.assign(row, result);
    else collection.push(result);
    return route.fulfill({ status: row ? 200 : 201, json: trim(kind, result) });
  });
  await page.route('**/api/tenant/employment/employees**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split('/')[5];
    if (options.personError) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
    const persons = [employee, otherEmployee].map((id, i) => ({
      id,
      name: i ? '合成导师乙' : '合成员工甲',
      code: `DEMO-${i}`,
      revision: 1,
      avatar: null,
    }));
    return route.fulfill({
      json: path.endsWith('/records')
        ? {
            items: [{ id: infoId, revision: 1, isCurrent: true, fields: { departmentId: orgId } }],
            page: 1,
            pageSize: 200,
          }
        : id
          ? persons.find((r) => r.id === id)
          : { items: persons, page: 1, pageSize: 200 },
    });
  });
  await page.route('**/api/tenant/personnel/employees/*', (route) =>
    route.fulfill({
      json: { id: route.request().url().split('/').at(-1), email: 'synthetic@example.com', workEmail: null },
    }),
  );
  await page.route('**/api/tenant/job/positions**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(positionId)
        ? { id: positionId, name: '合成轮岗职位', revision: 1 }
        : { items: [{ id: positionId, name: '合成轮岗职位' }], page: 1, pageSize: 200 },
    }),
  );
  return calls;
}
