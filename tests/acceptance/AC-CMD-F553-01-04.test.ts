import { randomUUID } from 'node:crypto';
import { commandLedger, grantMembership, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runWithAuditRequest } from '../../apps/api/src/audit/request-context.js';
import { commandTypeOf } from '../../apps/api/src/command-type.js';
import { runCommand } from '../../apps/api/src/commands.js';
import { AppError } from '../../apps/api/src/errors.js';
import { createCommandResultRegistry } from '../../apps/api/src/modules/command-result/registry.js';
import { ESIGN_COMMAND_RESULTS } from '../../apps/api/src/modules/esign/source-command-result.js';
import { expectHidden, resultPath, resultWorld, SOURCE_OBJECT, startPath } from './AC-CMD-F553-support.js';
import { insertTask } from './AC-ESIGN-F505-support.js';
import { SCENES, START } from './AC-ESIGN-F505-s2-support.js';
import { controlledApi } from './AC-LNK-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
type World = Awaited<ReturnType<typeof resultWorld>>;

async function insertReceipt(
  w: World,
  responseBody: object,
  commandType = commandTypeOf('POST', w.path),
  responseStatus = 201,
) {
  const commandId = uniqueSuffix();
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.insert(commandLedger).values({
      tenantId: w.tenantId,
      commandId,
      commandType,
      requestHash: uniqueSuffix(),
      actorUserId: w.userId,
      responseStatus,
      responseBody,
    }),
  );
  return resultPath(commandId);
}

it('AC-CMD-F553-01 应用装配时拒绝同一命令类型重复登记', () => {
  expect(createCommandResultRegistry(ESIGN_COMMAND_RESULTS).size).toBe(2);
  expect(() => createCommandResultRegistry([...ESIGN_COMMAND_RESULTS, ESIGN_COMMAND_RESULTS[0]!])).toThrow(
    '命令回查类型重复登记：POST /api/tenant/offers/:id/esign-tasks',
  );
});

it.each(SCENES)('AC-CMD-F553-01 %s 登记只命中精确命令类型，未登记仍返回 F-120 摘要', async (scene) => {
  const w = await resultWorld(db().db, scene);
  const body = { ...w.receipt, id: w.sourceId, revision: 4, kind: 'ZZ_F553_类型', name: 'ZZ_F553_模板名' };
  const otherType = commandTypeOf('POST', `${w.path}-other`);
  const unregistered = await insertReceipt(w, body, otherType);
  const registered = await insertReceipt(w, body);
  const call = controlledApi(
    w.db,
    w.tenantId,
    w.userId,
    { deny: ({ resource }) => resource === SOURCE_OBJECT[scene] },
    START.toISOString(),
  );
  const summary = await json<{ commandId: string; completedAt: string }>(await call('GET', unregistered));
  expect(summary).toEqual({
    commandId: unregistered.split('/')[4],
    commandType: otherType,
    businessType: body.kind,
    businessId: w.sourceId,
    revision: 4,
    status: 'succeeded',
    httpStatus: 201,
    completedAt: expect.any(String),
  });
  await expectHidden(await call('GET', registered), [403]);
  expect(await json(await w.api.request('GET', registered, w.as))).toEqual(w.receipt);
});

it.each(SCENES)('AC-CMD-F553-01 %s 审计只有业务失败时回查不交未绑定的摘要', async (scene) => {
  const w = await resultWorld(db().db, scene);
  const commandId = uniqueSuffix();
  await expect(
    runWithAuditRequest({ method: 'POST', path: w.path, clock: () => START }, () =>
      runCommand(w.db, w.asContext, {
        id: commandId,
        fingerprint: { path: w.path },
        execute: async () => {
          throw new AppError('CONFLICT', 'ZZ_F553_失败详情');
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expectHidden(await w.api.request('GET', resultPath(commandId), w.as), [404]);
});

it.each(SCENES)('AC-CMD-F553-04 %s 跨租户、他人、错误来源、错误任务或场景均与不存在同为 404', async (scene) => {
  const w = await resultWorld(db().db, scene);
  const other = await seedTenantWithMember(w.db, 'ZZ_F553_其他');
  await grantMembership(w.db, { tenantId: other.tenant.id, userId: w.userId, expectedRevision: 0 }, cmd());
  await grantMembership(w.db, { tenantId: w.tenantId, userId: other.user.id, expectedRevision: 0 }, cmd());

  const otherSource =
    scene === 'offer'
      ? await w.makeOffer()
      : (
          await w.session.business(
            (await w.session.employee('ZZ_F553_另一个人员')).id,
            { kind: 'hire', mode: 'direct', effectiveDate: '2026-11-02', fields: { departmentId: w.department.id } },
            1,
          )
        ).id;
  const anotherInitiator = await insertTask(w.db, w.tenantId, other.user.id, {
    scene,
    employeeId: w.person.id,
    ...(scene === 'offer' ? { offerId: w.sourceId } : { businessId: w.sourceId }),
    sourceRevision: 1,
    status: 'revoked',
  });

  const absent = await w.api.request('GET', resultPath(uniqueSuffix()), w.as);
  await expectHidden(absent.clone(), [404]);
  const body = await absent.json();
  const hidden = async (response: Response) => {
    await expectHidden(response.clone(), [404]);
    expect(await response.json()).toEqual(body);
  };
  await hidden(await w.api.request('GET', w.query, { ...w.as, tenant: other.tenant.id }));
  await hidden(await w.api.request('GET', w.query, { ...w.as, user: other.user.id }));
  const wrong = [
    await insertReceipt(w, { ...w.receipt, sourceId: otherSource }),
    await insertReceipt(w, { ...w.receipt, sourceId: randomUUID() }),
    await insertReceipt(w, { ...w.receipt, taskId: anotherInitiator }),
    await insertReceipt(w, { ...w.receipt, taskId: randomUUID() }),
    await insertReceipt(w, { ...w.receipt, taskId: 'ZZ_F553_错误任务ID' }),
    await insertReceipt(
      w,
      w.receipt,
      commandTypeOf('POST', startPath(scene === 'offer' ? 'entry' : 'offer', w.sourceId)),
    ),
    await insertReceipt(w, w.receipt, undefined, 409),
  ];
  for (const path of wrong) await hidden(await w.api.request('GET', path, w.as));
});
