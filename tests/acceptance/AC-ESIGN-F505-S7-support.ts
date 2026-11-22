import type { Db } from '@italent/db';
import type { ESignSourceKind } from '@italent/domain';
import { offerSigningWorld, OFFERS } from './AC-ESIGN-F505-S4-support.js';
import { s5World, BASE, NOW } from './AC-ESIGN-F505-s5-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

async function offerSource(db: Db) {
  const w = await offerSigningWorld(db, 'S7');
  const name = 'ZZ_F505_S7_Offer';
  const id = await w.offer({ name });
  return {
    id,
    name,
    template: await w.template(),
    listPath: `${OFFERS}?view=accepted`,
    sourcePath: `${OFFERS}/${id}`,
    tenantId: w.tenantId,
    initiator: w.userId,
    employee: w.employeeUser,
  };
}

async function entrySource(db: Db) {
  const w = await s5World(db);
  const entry = await w.pending();
  if (!entry.employeeUser) throw new Error('待入职夹具缺少签署账号');
  return {
    id: entry.id,
    name: entry.employee.name,
    template: await w.template(),
    listPath: `${BASE}?view=all`,
    sourcePath: `${BASE}/${entry.id}`,
    tenantId: w.as.tenant,
    initiator: w.as.user,
    employee: entry.employeeUser,
  };
}

/** 仅准备合成来源、现有签署人和模板。任务必须经来源写路由创建。 */
export async function s7World(db: Db, scene: ESignSourceKind) {
  const seed = await (scene === 'offer' ? offerSource(db) : entrySource(db));
  let now = new Date(NOW);
  const api = tenantApi(db, { clock: () => now });
  return {
    ...seed,
    call(method: string, path: string, options: RequestOptions = {}) {
      return api.request(method, path, { tenant: seed.tenantId, user: seed.initiator, ...options });
    },
    setNow(value: string) {
      now = new Date(value);
    },
  };
}
