/** SP-15：项目计算也有真实 run 来源，当前事务内终结，不交给后台重新写地图。 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@italent/db';
import type { OrgHealthComputePort, OrgHealthComputeResult } from '../talent-review/health-port.js';
import { CalcObjectFailure, type CalcContext, type CalcObject } from './calc-contract.js';
import { enqueueCalcRun, runCalcPageInTransaction } from './calc-worker.js';

type Input = Parameters<OrgHealthComputePort['compute']>[1];
export async function runProjectHealthCompute(
  tx: Tx,
  input: Input,
  now: Date,
  compute: (ctx: CalcContext, object: CalcObject) => Promise<OrgHealthComputeResult>,
) {
  const orgIds = [...new Set(input.orgIds.map((id) => id.toLowerCase()))];
  const runId = await enqueueCalcRun(
    tx,
    {
      tenantId: input.tenantId,
      kind: 'org_health',
      trigger: 'manual',
      requestedBy: input.principalUserId,
      commandId: `project-health:${input.context.projectId}:${input.context.meetingId ?? 'project'}:${randomUUID()}`,
      businessDate: input.businessDate,
      objects: orgIds.map((objectId) => ({ objectType: 'org', objectId })),
    },
    now,
  );
  const results = new Map<string, OrgHealthComputeResult>();
  await runCalcPageInTransaction(
    tx,
    input.tenantId,
    runId,
    {
      kind: 'org_health',
      objectType: 'org',
      authorizePage: async () => input.principalUserId,
      execute: async (ctx, object) => {
        const result = await compute(ctx, object);
        results.set(object.objectId, result);
        const failure = result.failures[0];
        if (failure)
          throw new CalcObjectFailure(
            failure.code,
            false,
            typeof failure.params?.levelId === 'string' ? failure.params.levelId : undefined,
            typeof failure.params?.rowNo === 'number' ? failure.params.rowNo : undefined,
          );
        // 等级交给项目端口写回；本地地图结果不发生变更。
        return 'unchanged';
      },
    },
    now,
  );
  return orgIds.map((id) => results.get(id)!);
}
