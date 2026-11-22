/** F-505 S5：补占位请求无法验证的真实入职来源、按钮、范围与签署字段裁剪。 */
import { and, eq, grantMembership, tenantMemberships, withTenant, type Db } from '@italent/db';
import {
  BASE,
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  NOW,
  RECORD_OBJECT,
  s5World,
  source,
} from '../../AC-ESIGN-F505-s5-support.js';
import { cmd, seedTenantWithMember, tenantApi } from '../tenant-api.js';
import { createAuthorizerDouble, type DoubleConfig } from './double.js';
import { observe } from './recorded.js';

const EDIT = `obj:${EMPLOYMENT_OBJECT}:update`;
const BUTTON = `btn:${EMPLOYMENT_OBJECT}#Employment.Edit@detail`;
const EMPLOYMENT_READ = `obj:${EMPLOYMENT_OBJECT}:view`;
const RECORD_READ = `obj:${RECORD_OBJECT}:view`;

type View = 'context' | 'tasks' | 'records';
interface Probe {
  readonly response: Response;
  readonly observed: {
    readonly status: number;
    readonly code?: string;
    readonly keys?: readonly string[];
    readonly trace: readonly string[];
    readonly scopeQueries: readonly string[];
    readonly fieldQueries: readonly string[];
  };
}

export const ENTRY_SIGN_PROBE_KEYS = {
  context: `GET ${BASE}/:id/esign-context`,
  tasks: `POST ${BASE}/:id/esign-tasks`,
  records: `GET ${BASE}/:id/esign-records`,
} as const;

export async function probeEntrySignBranches(db: Db) {
  const world = await s5World(db);
  const entry = await world.pending();
  const template = await world.template('ZZ_F505_姓名 {员工姓名}');
  const foreign = await seedTenantWithMember(db, 'ZZ_F505_探测外租户');
  await grantMembership(db, { tenantId: foreign.tenant.id, userId: world.as.user, expectedRevision: 0 }, cmd());
  const double = createAuthorizerDouble();
  const api = tenantApi(db, { authorize: double.authorize, clock: () => new Date(NOW) });
  const probe = async (
    view: View,
    config: DoubleConfig = {},
    revoke?: string,
    tenant = world.as.tenant,
  ): Promise<Probe> => {
    double.configure(config);
    double.reset();
    if (revoke) double.revoke(revoke);
    const write = view === 'tasks';
    const response = await api.request(write ? 'POST' : 'GET', source(entry.id, view), {
      ...world.as,
      tenant,
      ...(write ? { ifMatch: entry.revision, body: { templateIds: [template.id] } } : {}),
    });
    const { status, code, keys } = await observe(response);
    return {
      response,
      observed: {
        status,
        ...(code ? { code } : {}),
        ...(keys ? { keys } : {}),
        trace: double.permKeys(),
        scopeQueries: double.scopeKeys(),
        fieldQueries: double.fieldKeys(),
      },
    };
  };

  const context = {
    accepted: await probe('context'),
    noObject: await probe('context', {}, EDIT),
    noButton: await probe('context', {}, BUTTON),
    noScope: await probe('context', { scope: 'empty' }),
    foreign: await probe('context', {}, undefined, foreign.tenant.id),
  };
  const tasks = {
    noButton: await probe('tasks', {}, BUTTON),
    noScope: await probe('tasks', { scope: 'empty' }),
    noVariable: await probe('tasks', { fields: { hideFields: { [EMPLOYEE_OBJECT]: ['name'] } } }),
    accepted: await probe('tasks'),
  };
  const records = {
    accepted: await probe('records'),
    noSourceRead: await probe('records', {}, EMPLOYMENT_READ),
    noRecordRead: await probe('records', {}, RECORD_READ),
    noScope: await probe('records', { scope: 'empty' }),
    noFiles: await probe('records', { fields: { hideFields: { [RECORD_OBJECT]: ['files'] } } }),
  };
  await withTenant(db, world.as.tenant, (tx) =>
    tx
      .update(tenantMemberships)
      .set({ status: 'revoked' })
      .where(and(eq(tenantMemberships.tenantId, world.as.tenant), eq(tenantMemberships.userId, world.as.user))),
  );
  return { context: { ...context, inactive: await probe('context') }, tasks, records };
}

type EntrySignBranches = Readonly<Record<string, Probe['observed']>>;

export async function discoverEntrySignBranches(db: Db): Promise<Readonly<Record<string, EntrySignBranches>>> {
  const responses = await probeEntrySignBranches(db);
  const observed = (branches: Readonly<Record<string, Probe>>) =>
    Object.fromEntries(Object.entries(branches).map(([key, probe]) => [key, probe.observed]));
  return {
    [ENTRY_SIGN_PROBE_KEYS.context]: observed(responses.context),
    [ENTRY_SIGN_PROBE_KEYS.tasks]: observed(responses.tasks),
    [ENTRY_SIGN_PROBE_KEYS.records]: observed(responses.records),
  };
}
