import { buttonResource } from '@italent/domain';
import { testDbMode, useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { handledScene } from './AC-F476-p4-support.js';
import { controlledApi } from './AC-LNK-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { uniqueSuffix } from './support/unique.js';
import {
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  RECORD_OBJECT,
  resultPath,
  s5World,
  source,
  type Receipt,
} from './AC-ESIGN-F505-s5-support.js';

const database = useTestDb();
let w: Awaited<ReturnType<typeof s5World>>;
let templateId: string;

beforeAll(async () => {
  w = await s5World(database().db);
  templateId = (await w.template()).id;
});

it('AC-05 未来待入职按来源记录的 revision 发起，返回同来源最小回执', async () => {
  const entry = await w.pending();
  const result = await json<Receipt>(await w.submit(entry, [templateId]), 201);
  expect(result).toEqual({ sourceId: entry.id, taskId: expect.any(String) });
  expect(await w.tasks(entry)).toMatchObject([
    { id: result.taskId, sourceRevision: entry.revision, scene: 'entry', status: 'signing' },
  ]);
});

it('AC-06 上下文只列适用模板，严格拒绝空和重复 ID', async () => {
  const entry = await w.pending();
  const general = await w.template('{员工姓名} {工号} {发起日期} {企业名称}', 'ZZ_F505_通用变量');
  await w.template('{调入部门}', 'ZZ_F505_调动变量');
  const context = await json(await w.call('GET', source(entry.id, 'context')));
  expect(context).toEqual({
    sourceId: entry.id,
    revision: entry.revision,
    canInitiate: true,
    items: [
      { id: templateId, name: 'ZZ_F505_模板' },
      { id: general.id, name: general.name },
    ],
  });
  await w.error(await w.submit(entry, []), 400);
  await w.error(await w.submit(entry, [templateId, templateId]), 400);
  expect(await w.tasks(entry)).toEqual([]);
});

it('AC-07 人员变量须独立验字段与范围，纯文本可发起', async () => {
  const entry = await w.pending();
  const variable = await w.template('{员工姓名}', 'ZZ_F505_姓名模板');
  for (const grants of [{ fields: { [EMPLOYEE_OBJECT]: ['code'] } }, { scopes: { [EMPLOYEE_OBJECT]: EMPTY_SCOPE } }]) {
    await w.error(await w.submit(entry, [variable.id], uniqueSuffix(), grants), 403, 'FIELD_FORBIDDEN');
  }
  expect(await w.tasks(entry)).toEqual([]);
  await json(await w.submit(entry, [templateId], uniqueSuffix(), { fields: { [EMPLOYEE_OBJECT]: [] } }), 201);
});

it('AC-12 同键返回原任务，异内容和旧来源 revision 拒绝', async () => {
  const entry = await w.pending();
  const key = uniqueSuffix();
  const receipt = await json(await w.submit(entry, [templateId], key), 201);
  expect(await json(await w.submit(entry, [templateId], key), 201)).toEqual(receipt);
  const other = await w.template('ZZ_F505_第二份正文', 'ZZ_F505_第二份模板');
  await w.error(await w.submit(entry, [other.id], key), 409, 'IDEMPOTENCY_CONFLICT');
  await w.error(await w.submit({ ...entry, revision: entry.revision + 1 }, [templateId]), 409, 'REVISION_CONFLICT');
  expect(await w.tasks(entry)).toHaveLength(1);
});

it.skipIf(testDbMode() !== 'pg')('AC-12 真 PG 两新键并发只产生一条 signing', async () => {
  const entry = await w.pending();
  const results = await Promise.all([w.submit(entry, [templateId]), w.submit(entry, [templateId])]);
  expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
  expect(await w.tasks(entry)).toMatchObject([{ status: 'signing' }]);
});

it('AC-20 沿用详情编辑按钮且发起不要求 ESignSettings', async () => {
  const entry = await w.pending();
  const denyButton = {
    deny: ({ resource }: { resource?: string }) =>
      resource === buttonResource(EMPLOYMENT_OBJECT, 'Employment.Edit', 'detail'),
  };
  await w.error(await w.restricted(denyButton)('GET', source(entry.id, 'context')), 403);
  await w.error(await w.submit(entry, [templateId], uniqueSuffix(), denyButton), 403);
  const denySettings = { deny: ({ resource }: { resource?: string }) => resource === 'TenantBase.ESignSettings' };
  const offerOnly = w.restricted({
    deny: ({ resource, action }) => action !== 'object.update' || resource !== 'TenantBase.Offer',
  });
  await w.error(await offerOnly('GET', source(entry.id, 'context')), 403);
  await w.error(
    await offerOnly('POST', source(entry.id, 'tasks'), {
      ifMatch: entry.revision,
      body: { templateIds: [templateId] },
    }),
    403,
  );
  await json(await w.restricted(denySettings)('GET', source(entry.id, 'context')));
  await json(await w.submit(entry, [templateId], uniqueSuffix(), denySettings), 201);
});

it('AC-21 原命令按 F-553 回查，当前来源权和人员变量权同时约束重放', async () => {
  const entry = await w.pending();
  const variable = await w.template('{工号}', 'ZZ_F505_工号模板');
  const key = uniqueSuffix();
  const receipt = await json(await w.submit(entry, [variable.id], key), 201);
  expect(await json(await w.call('GET', resultPath(key)))).toEqual(receipt);
  await json(
    await w.call('PATCH', `/api/tenant/esign/templates/${variable.id}`, {
      ifMatch: variable.revision,
      body: { body: 'ZZ_F505_模板改为静态正文' },
    }),
  );
  const revocations = [
    { status: 403, grants: { deny: ({ resource }: { resource?: string }) => resource === EMPLOYMENT_OBJECT } },
    {
      status: 403,
      grants: {
        deny: ({ resource }: { resource?: string }) =>
          resource === buttonResource(EMPLOYMENT_OBJECT, 'Employment.Edit', 'detail'),
      },
    },
    { status: 404, grants: { scopes: { [EMPLOYMENT_OBJECT]: EMPTY_SCOPE } } },
    { status: 403, grants: { fields: { [EMPLOYEE_OBJECT]: ['name'] } } },
  ];
  for (const { status, grants } of revocations) {
    await w.error(await w.restricted(grants)('GET', resultPath(key)), status);
    await w.error(await w.submit(entry, [variable.id], key, grants), status);
  }
});

it('AC-21 来源历史在分页前应用双范围，文件和状态逐字段裁剪', async () => {
  const entry = await w.pending();
  const { taskId } = await json<Receipt>(await w.submit(entry, [templateId]), 201);
  const records = source(entry.id, 'records');
  const masked = await w.restricted({ fields: { [RECORD_OBJECT]: [] } })('GET', records);
  expect(await json(masked)).toEqual({ items: [{ id: taskId, revision: 1 }], total: 1, page: 1, pageSize: 20 });
  const limited = await w.restricted({ scopes: { [RECORD_OBJECT]: EMPTY_SCOPE } })('GET', records);
  expect(await json(limited)).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  await w.error(await w.restricted({ scopes: { [EMPLOYMENT_OBJECT]: EMPTY_SCOPE } })('GET', records), 404);
  const denied = await w.restricted({ deny: ({ resource }) => resource === RECORD_OBJECT })('GET', records);
  expect(await w.error(denied, 403)).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } });
});

it('AC-21 审批人只能读已办理的冻结份，不能用于签署发起或读来源历史', async () => {
  const scene = await handledScene(database().db, 'ZZ_F505_冻结', 'hire');
  const { businessId, approver } = scene;
  const call = controlledApi(
    scene.w.db,
    scene.w.tenant.id,
    approver.userId,
    {
      scopes: { [EMPLOYMENT_OBJECT]: EMPTY_SCOPE },
    },
    scene.w.clock().toISOString(),
  );
  const old = await json<{ revision: number; contentView?: { mode: string } }>(
    await call('GET', `/api/tenant/employment/businesses/${businessId}`),
  );
  expect(old.contentView?.mode).toBe('frozen');
  await w.error(await call('GET', source(businessId, 'context')), 404, 'NOT_FOUND');
  await w.error(
    await call('POST', source(businessId, 'tasks'), {
      ifMatch: old.revision,
      body: { templateIds: [templateId] },
    }),
    404,
    'NOT_FOUND',
  );
  await w.error(await call('GET', source(businessId, 'records')), 404, 'NOT_FOUND');
});
