/** F-011 / DEC-151：新建职位、变更所属组织共用 DEC-139 / 150 的整段停用判定。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, type JobRecord, type JobSession } from './AC-JOB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const START = '2026-10-05';
type Mode = 'create' | 'change';

async function changeOrg(session: JobSession, org: { id: string; revision: number }, body: Record<string, unknown>) {
  const response = await tenantApi(testDb().db).request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
    user: session.user.id,
    tenant: session.tenant.id,
    ifMatch: org.revision,
    body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { id: string; revision: number };
}

async function scenario(mode: Mode) {
  const session = await jobSession(testDb().db, `job07-${mode}`);
  const target = await session.org('目标组织');
  const post = await session.create('posts', '测试职务');
  const source = await session.org('原组织');
  const position =
    mode === 'change' ? await session.create('positions', '原职位', { orgId: source.id, postId: post.id }) : undefined;
  function save(orgId = target.id) {
    return position
      ? session.request('PATCH', `/positions/${position.id}`, {
          ifMatch: position.revision,
          body: { orgId, effectiveDate: START },
        })
      : session.request('POST', '/positions', {
          ifMatch: 0,
          body: { name: '新职位', code: `P${randomUUID()}`, orgId, postId: post.id, startDate: START },
        });
  }
  async function unchanged() {
    const positions = await session.list('positions', { asOf: START });
    expect(positions).toHaveLength(position ? 1 : 0);
    if (position) expect(positions[0]).toMatchObject({ id: position.id, orgId: source.id, revision: 1 });
  }
  return { session, target, source, position, save, unchanged };
}

async function expectDisabled(response: Response, name: string, date: string) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'VALIDATION_FAILED',
      message: `选中的所属组织【${name}】在（${date}）时为停用状态`,
      details: { field: 'orgId' },
    },
  });
}

describe.each(['create', 'change'] as const)('AC-JOB-07 %s 职位整段组织校验', (mode) => {
  it.each(['2026-10-10', '2026-10-05', '2026-10-01'])(
    '开始日之后、当天或之前（%s）停用均拒绝，提示实际停用日，失败不写职位版本',
    async (disabledOn) => {
      const s = await scenario(mode);
      await changeOrg(s.session, s.target, { enabled: false, effectiveDate: disabledOn });
      await expectDisabled(await s.save(), s.target.name, disabledOn);
      await s.unchanged();
    },
  );

  it('未来停用后又恢复启用，仍拒绝中间的停用时段', async () => {
    const s = await scenario(mode);
    const disabled = await changeOrg(s.session, s.target, { enabled: false, effectiveDate: '2026-10-10' });
    await changeOrg(s.session, disabled, { enabled: true, effectiveDate: '2026-10-12' });
    await expectDisabled(await s.save(), s.target.name, '2026-10-10');
    await s.unchanged();
  });

  it('停用后更名显示连续停用段的起日', async () => {
    const s = await scenario(mode);
    const disabled = await changeOrg(s.session, s.target, { enabled: false, effectiveDate: '2026-10-01' });
    await changeOrg(s.session, disabled, { addEmployment: false, name: '停用后更名组织', effectiveDate: '2026-10-03' });
    await expectDisabled(await s.save(), '停用后更名组织', '2026-10-01');
    await s.unchanged();
  });

  it.each(['always', '2026-10-02', '2026-10-10'])(
    '整段启用成功（%s：始终启用 / 开始日前恢复 / 未来同日停用被启用覆盖）',
    async (restoredOn) => {
      const s = await scenario(mode);
      if (restoredOn !== 'always') {
        const disabled = await changeOrg(s.session, s.target, {
          enabled: false,
          effectiveDate: restoredOn === '2026-10-02' ? '2026-10-01' : restoredOn,
        });
        await changeOrg(s.session, disabled, { enabled: true, effectiveDate: restoredOn });
      }
      const response = await s.save();
      expect(response.status, await response.clone().text()).toBe(mode === 'create' ? 201 : 200);
      const saved = (await response.json()) as JobRecord;
      expect(saved).toMatchObject({ orgId: s.target.id, startDate: START, revision: mode === 'create' ? 1 : 2 });
      expect(await s.session.detail('positions', saved.id, START)).toMatchObject({ orgId: s.target.id });
      if (s.position) {
        expect(await s.session.detail('positions', saved.id, '2026-10-04')).toMatchObject({ orgId: s.source.id });
      }
    },
  );

  it('跨租户组织始终拒绝，停用日期与名称不泄露', async () => {
    const s = await scenario(mode);
    const foreign = await jobSession(testDb().db, `job07-foreign-${mode}`);
    const org = await foreign.org('外租户保密组织');
    for (const disabled of [false, true]) {
      if (disabled) await changeOrg(foreign, org, { enabled: false, effectiveDate: '2026-10-10' });
      const response = await s.save(org.id);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', message: '所属组织不存在、未生效、已停用或不在当前租户' },
      });
      await s.unchanged();
    }
  });
});

it('AC-JOB-07 未改所属组织的职位变更保留既有校验范围', async () => {
  const s = await scenario('change');
  const stopped = await s.session.request('PATCH', `/positions/${s.position!.id}`, {
    ifMatch: s.position!.revision,
    body: { enabled: false, effectiveDate: '2026-10-02' },
  });
  expect(stopped.status).toBe(200);
  await changeOrg(s.session, s.source, { enabled: false, effectiveDate: '2026-10-10' });
  const response = await s.session.request('PATCH', `/positions/${s.position!.id}`, {
    ifMatch: s.position!.revision + 1,
    body: { name: '仅改职位名称', effectiveDate: START },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ name: '仅改职位名称', orgId: s.source.id, revision: 3 });
});
