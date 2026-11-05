/**
 * F-356（FE-R2c3 Sol high R1，DEC-406）：退休办理 / 申请的载荷带 kind / mode，服务端按任职对象字段编辑权整单复核
 * （exit-gate.ts createPayload）。没有 kind 或 mode 编辑权的人提交一律 403、不建单；有权（缺的只是无关字段）照常 201。
 * 前端侧：同样没有这两项编辑权时不出退休办理 / 退休申请入口，见 tests/acceptance/AC-FE-R2c3.test.ts 与
 * apps/web/smoke/AC-FE-R2c3.smoke.spec.ts。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dedicatedBody, retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-15';

/** 对象新增 / 编辑放行，但 denied 里的字段没有编辑权（授权器按载荷键判，任一不可写整单 403）。 */
const denyFields =
  (...denied: string[]): Authorizer =>
  (request) =>
    !['object.create', 'object.update'].includes(request.action) ||
    !(request.fields ?? []).some((field) => denied.includes(field));

async function create(label: string, authorize: Authorizer, mode: 'application' | 'direct') {
  const x = await retirementWorld(database().db, label, TODAY);
  const before = await x.stateCounts();
  const request = x.restricted(authorize);
  const response = await request('POST', `/retirements/employees/${x.employee.id}`, {
    ifMatch: (await x.session.getEmployee(x.employee.id)).revision,
    body: dedicatedBody(LAST_WORK_DATE, mode),
  });
  return { x, before, response };
}

describe('F-356 退休办理 / 申请的 kind / mode 受字段编辑权管', () => {
  for (const mode of ['application', 'direct'] as const) {
    for (const field of ['kind', 'mode']) {
      it(`${mode}：没有 ${field} 编辑权 → 403，不建单、不改状态`, async () => {
        const { x, before, response } = await create(`f356-${mode}-${field}`, denyFields(field), mode);
        expect(response.status, await response.clone().text()).toBe(403);
        expect(await x.stateCounts()).toEqual(before);
      });
    }
    it(`${mode}：kind / mode / 最后工作日都有编辑权（缺的只是无关字段）→ 201`, async () => {
      const { response } = await create(`f356-${mode}-ok`, denyFields('intendedDate'), mode);
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({ kind: 'retirement' });
    });
  }
});
