import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { levelBody, levelsWorld } from './AC-SC-levels-support.js';

export async function levelReferenceWorld(db: Db) {
  const w = await levelsWorld(db);
  const path = '/api/tenant/talent-review/fields';
  const created = await w.raw.request('POST', path, {
    ...w.asAdmin,
    ifMatch: 0,
    body: { code: `fld_${randomUUID().replaceAll('-', '')}`, name: randomUUID(), kind: 'number', group: 'evaluation' },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const field = (await created.json()) as { id: string; code: string; revision: number };
  const body = levelBody('health');
  const row = {
    ...body.rules.rows[0]!,
    fieldSource: 'review',
    fieldCode: field.code,
    filterValues: [30],
    measure: 'average',
  };
  const referenceBody = { ...body, rules: { expression: '1', rows: [row] } };
  const fieldRequest = (method: string) =>
    w.raw.request(method, `${path}/${field.id}`, { ...w.asAdmin, ifMatch: field.revision });
  const reference = () => w.request('POST', '/health-levels', { body: referenceBody });
  return { ...w, field, fieldRequest, reference };
}
