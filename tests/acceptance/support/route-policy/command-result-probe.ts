/** F-553：Tier 0 占位命令没有台账。用实际签署命令补同一端点的两个数据态分支。 */
import type { Db } from '@italent/db';
import { EMPLOYEE_OBJECT } from '../../../../apps/api/src/modules/employment/context.js';
import { resultWorld, SOURCE_OBJECT } from '../../AC-CMD-F553-support.js';
import { SCENES, START, type Scene } from '../../AC-ESIGN-F505-s2-support.js';
import { tenantApi } from '../tenant-api.js';
import { createAuthorizerDouble, type DoubleConfig } from './double.js';
import { observe } from './recorded.js';

export async function probeCommandResultBranch(db: Db, scene: Scene) {
  const world = await resultWorld(db, scene);
  const double = createAuthorizerDouble();
  const api = tenantApi(db, { authorize: double.authorize, clock: () => START });
  const edit = `obj:${SOURCE_OBJECT[scene]}:update`;
  const button = 'btn:TenantBase.EmploymentRecord#Employment.Edit@detail';

  async function probe(config: DoubleConfig = {}, revoke?: string) {
    double.configure(config);
    double.reset();
    if (revoke) double.revoke(revoke);
    const response = await api.request('GET', world.query, world.as);
    const seen = await observe(response);
    return {
      response,
      observed: {
        status: seen.status,
        ...(seen.code ? { code: seen.code } : {}),
        trace: double.permKeys(),
        scopeQueries: double.scopeKeys(),
        fieldQueries: double.fieldKeys(),
        inTransaction:
          double.requests.every((request) => request.via === 'transaction') &&
          double.fieldQueries.every((query) => query.inTransaction),
      },
    };
  }

  const accepted = await probe();
  const deniedEdit = await probe({}, edit);
  const deniedScope = await probe({ scope: 'empty' });
  const deniedVariable = await probe({ fields: { hideFields: { [EMPLOYEE_OBJECT]: ['name'] } } });
  const deniedButton = scene === 'entry' ? await probe({}, button) : undefined;
  const observations = {
    accepted: accepted.observed,
    deniedEdit: deniedEdit.observed,
    deniedScope: deniedScope.observed,
    deniedVariable: deniedVariable.observed,
    ...(deniedButton ? { deniedButton: deniedButton.observed } : {}),
  };
  return { world, observations, accepted, deniedEdit, deniedScope, deniedVariable, deniedButton };
}

export async function probeCommandResultBranches(db: Db) {
  const [offer, entry] = SCENES;
  return {
    [offer]: (await probeCommandResultBranch(db, offer)).observations,
    [entry]: (await probeCommandResultBranch(db, entry)).observations,
  };
}
