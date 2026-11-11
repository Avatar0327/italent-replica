/**
 * AC-DM-30-F493-16①②/23①②③/37：历史离职导入提交的权限链（S3a，设计 §6.1）。
 * 真实授权器（不注入 authorize 替身）：按身份逐对象配置字段写权、按钮、看全部范围，再用该身份提交。
 * 提交权限在入口与命令事务内各复核一次；任一不满足 403，且不落批次、不写人员。
 */
import './support/exit-gate-enforced.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { installExitImportTestHooks } from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));
const BUTTON = 'Employment.DimissionImport';
const EMPLOYEE = MODULE_OBJECTS.employee.code;
const RECORD = MODULE_OBJECTS.employmentRecord.code;
const EDUCATION = SUBSETS.education.objectCode;
const OBJECTS = [...Object.values(MODULE_OBJECTS), ...PERSONNEL_OBJECTS];

/** 本身份缺的权限：某对象的某字段写权 / 新增权 / 看全部范围 / 导入按钮。 */
interface Revoke {
  field?: [object: string, field: string];
  noCreate?: string;
  noScope?: string;
  noButton?: boolean;
  /** 收回某对象的某按钮（档案更新 / 教育新增按钮权，与对象写权分开判）。 */
  noObjectButton?: [object: string, button: string];
}

/** 配一个除 `revoke` 外什么都有的身份，返回用它提交的函数。 */
async function operator(x: ImportWorld, revoke: Revoke = {}) {
  const { tenant, user } = x.session;
  const pw = {
    db: x.db,
    tenant,
    admin: user,
    adminRecord: await bootstrapTenantAdmin(x.db, { tenantId: tenant.id, userId: user.id }, cmd()),
    api: tenantApi(x.db, { authorize: undefined, clock: () => new Date('2026-11-05T01:00:00Z') }),
    asAdmin: { user: user.id, tenant: tenant.id },
  };
  const profile = await createProfile(pw, `imp-${uniqueSuffix()}`, { apps: ['TenantBase'] });
  /** 按 `revoke` 重配身份的对象权限（可在授权后再次调用，用于撤权场景）。 */
  const configure = async (missing: Revoke) => {
    for (const definition of OBJECTS) {
      const response = await setObjectPermission(
        pw,
        profile,
        {
          dataOperations: { create: missing.noCreate !== definition.code, update: true, delete: true },
          fields: definition.fields.map((f) => ({
            fieldCode: f.code,
            view: true,
            edit: !f.system && !(missing.field?.[0] === definition.code && missing.field[1] === f.code),
          })),
          buttons: definition.buttons
            .filter((b) => !(missing.noButton && b.code === BUTTON))
            .filter((b) => !(missing.noObjectButton?.[0] === definition.code && missing.noObjectButton[1] === b.code))
            .map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        definition.code,
      );
      expect(response.status, `${definition.code} ${await response.clone().text()}`).toBe(200);
    }
  };
  await configure(revoke);
  for (const target of [RECORD, EMPLOYEE, PERSONNEL_OBJECT, EDUCATION].filter((t) => t !== revoke.noScope)) {
    const response = await pw.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
      {
        ...pw.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: target, seeAll: true },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(pw, [profile.id]);
  const member = await addMember(pw, `imp-op-${uniqueSuffix()}`);
  expect((await grant(pw, member.id, profile.id)).status).toBe(201);
  const submit = (rows: readonly unknown[], options: { key?: string | null } = {}) =>
    pw.api.request('POST', '/api/tenant/employment/exits/import', {
      user: member.id,
      tenant: tenant.id,
      body: { fileName: '合成导入.xlsx', rows },
      idempotencyKey: options.key === undefined ? `dm30-authz-${uniqueSuffix()}` : options.key,
    });
  return Object.assign(submit, { reconfigure: configure });
}

const denied = async (x: ImportWorld, revoke: Revoke, rows: (d: string) => unknown[]) => {
  const d = await x.dept('权限部门');
  const submit = await operator(x, revoke);
  const before = await x.writeCounts();
  const response = await submit(rows(d.code));
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await x.writeCounts()).toEqual(before);
};

describe('AC-DM-30-F493-16 ①② 提交权限', () => {
  it('① 没有导入按钮 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '16-1');
    await denied(x, { noButton: true }, (code) => [x.row(1, code)]);
  });

  it.each([
    ['任职记录', RECORD],
    ['人员', EMPLOYEE],
    ['人员档案', PERSONNEL_OBJECT],
  ])('② 没有%s对象的显式看全部范围 → 403，不落批次', async (_name, target) => {
    const x = await importWorld(database().db, `16-2-${target}`);
    await denied(x, { noScope: target }, (code) => [x.row(1, code)]);
  });
});

describe('AC-DM-30-F493-23 真实授权器下的提交', () => {
  it('① 权限齐全 → 202，执行后建人、建账号', async () => {
    const x = await importWorld(database().db, '23-1');
    const d = await x.dept('齐权部门');
    const submit = await operator(x);
    const response = await submit([x.row(1, d.code)]);
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    expect((await x.rowsOfBatch(batchId))[0]!.status).toBe('succeeded');
    expect(await x.employeeCount()).toBe(1);
  });

  it.each([
    ['② 收回任职 lastWorkDate 写权', RECORD, 'lastWorkDate'],
    ['③ 收回人员 code 写权', EMPLOYEE, 'code'],
  ])('%s → 403；不落批次', async (_name, object, field) => {
    // 每个身份配一次租户管理员，同一世界只能配一次，所以两个场景各开一个世界
    const x = await importWorld(database().db, `23-${field}`);
    await denied(x, { field: [object, field] }, (code) => [x.row(1, code)]);
  });
});

describe('AC-DM-30-F493-23 ④ 执行期权限复核（真实授权器，S3b，设计 §16 A9）', () => {
  it('提交后、执行前收回任职 lastWorkDate 写权 → 剩余 pending 行全部 SUBMITTER_FORBIDDEN，不写人员', async () => {
    const db = database().db;
    const x = await importWorld(db, '23-4');
    const d = await x.dept('执行期撤权部门');
    const submit = await operator(x);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installExitImportTestHooks(db, { beforeBatch: () => gate });
    const response = await submit([1, 2].map((n) => x.row(n, d.code)));
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };

    await submit.reconfigure({ field: [RECORD, 'lastWorkDate'] });
    release();
    await x.settle();

    expect(await x.rowsOfBatch(batchId)).toMatchObject(
      [1, 2].map(() => ({ status: 'failed', errors: [{ column: null, reason: 'SUBMITTER_FORBIDDEN' }] })),
    );
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', created_count: 0, error_row_count: 2 });
    expect(await x.employeeCount()).toBe(0);
  });
});

describe('AC-DM-30-F493-09/10 重放与幂等键（真实授权器）', () => {
  it('第一次成功后撤掉导入按钮：同键重放 403，不回放 202，批次数不变', async () => {
    const x = await importWorld(database().db, '09-replay');
    const d = await x.dept('撤权重放部门');
    const submit = await operator(x);
    const key = `dm30-replay-${uniqueSuffix()}`;
    const first = await submit([x.row(1, d.code)], { key });
    expect(first.status, await first.clone().text()).toBe(202);
    await x.settle();
    await submit.reconfigure({ noButton: true });
    const before = await x.writeCounts();
    const replay = await submit([x.row(1, d.code)], { key });
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
  });

  it('缺 Idempotency-Key → 400，零写入', async () => {
    const x = await importWorld(database().db, '10-nokey');
    const d = await x.dept('缺键部门');
    const submit = await operator(x);
    const before = await x.writeCounts();
    const response = await submit([x.row(1, d.code)], { key: null });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await x.writeCounts()).toEqual(before);
  });
});

describe('AC-DM-30-F493-37 档案字段写权（真实授权器）', () => {
  it('收回档案 email 写权 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-email');
    await denied(x, { field: [PERSONNEL_OBJECT, 'email'] }, (code) => [x.row(1, code)]);
  });

  it('只收回 mobilePhone 写权：L 列全空时 202；任一行 L 有值时 403', async () => {
    const x = await importWorld(database().db, '37-phone');
    const d = await x.dept('手机号部门');
    const submit = await operator(x, { field: [PERSONNEL_OBJECT, 'mobilePhone'] });
    const empty = await submit([x.row(1, d.code)]);
    expect(empty.status, await empty.clone().text()).toBe(202);
    await x.settle();
    const before = await x.writeCounts();
    const filled = await submit([x.row(2, d.code), x.row(3, d.code, { mobilePhone: '13800000002' })]);
    expect(filled.status).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
  });

  // 写入端口还会设置「最高学历」「主修专业」两个标志：授权按实际写入字段的并集判（与实习生建档同口径）
  it.each(['isHighestEducation', 'isMainMajor'])('T/U 列有值但没有教育经历 %s 写权 → 403，不落批次', async (flag) => {
    const x = await importWorld(database().db, `37-${flag}`);
    await denied(x, { field: [EDUCATION, flag] }, (code) => [
      x.row(1, code, { school: '合成大学', major: '合成专业' }),
    ]);
  });

  it('对照：权限齐全且 T/U 列有值 → 202，教育经历带两个标志', async () => {
    const x = await importWorld(database().db, '37-edu-ok');
    const d = await x.dept('有教育部门');
    const submit = await operator(x);
    const response = await submit([x.row(1, d.code, { school: '合成大学', major: '合成专业' })]);
    expect(response.status, await response.clone().text()).toBe(202);
  });

  it('只收回 isMainMajor 写权：T、U 列全空时仍 202（不写教育经历就不需要这些字段权）', async () => {
    const x = await importWorld(database().db, '37-flag-empty');
    const d = await x.dept('无教育部门');
    const submit = await operator(x, { field: [EDUCATION, 'isMainMajor'] });
    const response = await submit([x.row(1, d.code)]);
    expect(response.status, await response.clone().text()).toBe(202);
  });

  // 按钮权与对象 / 字段写权分开判：F-039 静态探测器观测不到这条链（经 exitImportGuard 进入），由本组测试兜底
  it('收回档案「更新」按钮权（对象与字段写权都在）→ 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-btn-update');
    await denied(x, { noObjectButton: [PERSONNEL_OBJECT, 'update'] }, (code) => [x.row(1, code)]);
  });

  it('T 列有值但收回教育「新增」按钮权 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-btn-create');
    await denied(x, { noObjectButton: [EDUCATION, 'create'] }, (code) => [x.row(1, code, { school: '合成大学' })]);
  });

  it('T 列有值但没有教育经历新增权 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-edu');
    await denied(x, { noCreate: EDUCATION }, (code) => [x.row(1, code, { school: '合成大学' })]);
  });
});
