import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const SUBSETS = [
  ['education', { educationLevel: '本科', school: '合成大学' }],
  ['jobhistory', { company: '合成单位', responsibilities: '研究' }],
  ['family', { name: '合成家属', relationship: '父母' }],
  ['training', { name: '合成培训', hours: 8 }],
  ['certificate', { name: '合成证书', number: 'SYN-001' }],
  ['awards', { name: '合成奖项', category: '集体' }],
  ['project-experience', { name: '合成项目', headcount: 3 }],
  ['skill', { name: '合成技能', months: 12 }],
  ['language-ability', { language: '中文', isNative: true }],
  ['estimation-result', { year: 2026, totalGrade: 'A', finalScore: 95 }],
  ['punish', { month: '2026-01', description: '合成记录' }],
  ['professional-technical-post', { qualificationName: '合成资格', level: '高级' }],
  ['vocational-qualification', { name: '合成职业资格', level: '高级' }],
] as const;

export async function personnelSession(db: Db, label = 'personnel') {
  const employment = await employmentSession(db, label);
  const employee = await employment.employee();
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { user: employment.user.id, tenant: employment.tenant.id };
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/personnel${path}`, { ...options, ...as });
  const path = (kind: string) => `/employees/${employee.id}/subsets/${kind}`;
  async function add(kind: string, body: object, options: RequestOptions = {}) {
    const response = await request('POST', path(kind), { ifMatch: 0, body, ...options });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Record<string, unknown> & { id: string; revision: number };
  }
  return { ...employment, employee, api, as, request, path, add };
}
