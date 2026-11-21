import { randomUUID } from 'node:crypto';
import { and, eq, esignTemplates, offers, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS, OFFER_OBJECT } from '@italent/domain';
import { sharedWorld, START } from './AC-ESIGN-F505-s2-support.js';
import { controlledApi, type ControlledGrants } from './AC-LNK-support.js';
import { uniqueSuffix } from './support/unique.js';

export const OFFERS = '/api/tenant/offers';
export const RECORD = MODULE_OBJECTS.eSignRecord.code;
export const EMPLOYEE = MODULE_OBJECTS.employee.code;
export { OFFER_OBJECT };
export const contextPath = (id: string) => `${OFFERS}/${id}/esign-context`;
export const taskPath = (id: string) => `${OFFERS}/${id}/esign-tasks`;
export const recordsPath = (id: string) => `${OFFERS}/${id}/esign-records`;
export const resultPath = (key: string) => `/api/tenant/commands/${key}/result`;
export type Receipt = { sourceId: string; taskId: string };

export async function offerSigningWorld(db: Db, label: string) {
  const w = await sharedWorld(db, label);
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, w.tenantId, fn);
  const offer = async (overrides: Partial<typeof offers.$inferInsert> = {}) => {
    const id = randomUUID();
    await inTenant((tx) =>
      tx.insert(offers).values({
        id,
        entry: 'offer',
        name: 'ZZ_F505_候选人',
        personalEmail: `f505-${uniqueSuffix()}@example.com`,
        status: 'accepted',
        acceptTime: START,
        ...(overrides.status === 'rejected' ? { refusalTime: START, refusalReasonCode: 'ZZ_F505_REFUSAL' } : {}),
        ...(overrides.status === 'invalid' ? { invalidAt: START, invalidReasonCode: 'ZZ_F505_INVALID' } : {}),
        createdBy: w.userId,
        tenantId: w.tenantId,
        departmentId: w.from.id,
        linkedEmployeeId: w.employeeId,
        ...overrides,
      }),
    );
    return id;
  };
  const patchTemplate = (id: string, patch: Partial<typeof esignTemplates.$inferInsert>) =>
    inTenant((tx) =>
      tx
        .update(esignTemplates)
        .set(patch)
        .where(and(eq(esignTemplates.tenantId, w.tenantId), eq(esignTemplates.id, id))),
    );
  const access = (grants: ControlledGrants = {}, user = w.userId) =>
    controlledApi(db, w.tenantId, user, grants, START.toISOString());
  const post = (id: string, templateIds: string[], key = uniqueSuffix(), ifMatch = 1, call = access()) =>
    call('POST', taskPath(id), { body: { templateIds }, ifMatch, key });
  return { ...w, offer, patchTemplate, access, post, inTenant };
}
