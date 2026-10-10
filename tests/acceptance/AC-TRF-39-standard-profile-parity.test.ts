/**
 * R3-T02 C1-2b（AC-TRF-39-standard-profile-parity）：标准“员工”身份与本人调动入口（契约 §2.3、§4 E2 / E5、§7 必测 4、6、6a）。
 * 作用对象：复刻系统。全部走真实 HTTP + 真实授权器，不物化员工授权行。
 * - E2：直接建的租户（无身份行，走兜底）与装有标准员工身份的租户，同一组本人调动操作逐项同输出；
 * - E5：租户收紧标准行的字段，预览实时跟随；
 * - 6a：三个按钮（Transfer.Self / Employment.Create / Employment.Submit）可在标准行上逐个关闭，预览与提交都 403
 *   `SELF_TRANSFER_BUTTON_DENIED`，不留业务痕迹；检查挂在 runWrite 的 guard.before（ledgerExit 唯一出口），所以
 *   直接重放与“失败后回查”两个出口撤权后同样 403，不返回原 201。
 * 区分力（实现 PR 描述写明实测）：去掉 POST /transfer 传给 runWrite 的 guard，重放 / 回查 / 首次执行用例失败；
 * 去掉预览里的首步调用，预览用例失败。
 * 失败后回查沿用 AC-EV-config-dicts-recheck 的败者模拟：mock runCommand，败者开事务前让胜者完整提交并暂时移走其台账行。
 */
import { randomUUID } from 'node:crypto';
import { auditEvents, commandLedger, type Db, eq, sql, transferRequests, type Tx, withTenant } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_BUTTONS, EMPLOYEE_SELF_SERVICE_CODE, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import type * as RunCommands from '../../apps/api/src/commands.js';
import { approvalWorld, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { putObject } from './support/f061.js';
import { tenantApi } from './support/tenant-api.js';

type RunCommandModule = typeof RunCommands;
interface Loser {
  readonly winner: () => Promise<Response>;
  readonly afterLoserTx: () => Promise<void>;
  winnerResponse?: Response;
}
const hooks = vi.hoisted(() => ({ loser: undefined as undefined | Loser }));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<RunCommandModule>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const loser = hooks.loser;
      hooks.loser = undefined;
      if (!loser) return original.runCommand(...args);
      const [db, ctx, command] = args;
      loser.winnerResponse = await loser.winner();
      return original.runCommand(loserDb(db, ctx.tenantId, command.id!, loser), ctx, command);
    },
  };
});

function asOwner<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
/** 败者主事务开始前移走胜者的台账行，结束（回滚）后放回并执行 afterLoserTx；之后的事务（回查）原样。 */
function loserDb(db: Db, tenantId: string, commandId: string, loser: Loser): Db {
  let first = true;
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    if (!first) return db.transaction(fn);
    first = false;
    const [row] = await asOwner(db, tenantId, (tx) =>
      tx.delete(commandLedger).where(eq(commandLedger.commandId, commandId)).returning(),
    );
    if (!row) throw new Error('胜者没有写台账，模拟前提不成立');
    try {
      return await db.transaction(fn);
    } finally {
      await asOwner(db, tenantId, (tx) => tx.insert(commandLedger).values(row));
      await loser.afterLoserTx();
    }
  }) as Db['transaction'];
  return wrapper;
}

const database = useTestDb();
const BASE = '/api/tenant/self-service';
const RECORD = 'TenantBase.EmploymentRecord';
const EMP = EMPLOYEE_SELF_SERVICE_CODE;
const EMP_DEF = STANDARD_PROFILES.find((p) => p.code === EMP)!;
const BUTTONS = EMPLOYEE_SELF_SERVICE_BUTTONS.map((b) => b.buttonCode);

type World = Awaited<ReturnType<typeof approvalWorld>>;
type Admin = Awaited<ReturnType<typeof permissionAdmin>>;
interface Fixture {
  world: World;
  api: ReturnType<typeof tenantApi>;
  admin: Admin;
  department: string;
  profileId: string;
}
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function fixture(label: string, withIdentity: boolean): Promise<Fixture> {
  const world = await approvalWorld(database().db, label);
  const api = tenantApi(database().db, { authorize: undefined, clock: world.clock });
  const admin = await permissionAdmin(world);
  const department = await world.org('合成部门');
  await world.publishedProcess({ nodes: [{ key: 'owner_review', approver: 'owner' }] });
  let profileId = '';
  if (withIdentity) {
    const write = { tenantId: world.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() };
    profileId = (await withTenant(world.db, world.tenant.id, (tx) => installProfile(tx, write, EMP_DEF))).id;
  }
  return { world, api, admin, department, profileId };
}
const call = (f: Fixture, person: Person, path: string, method = 'GET', body?: unknown, extra: object = {}) =>
  f.api.request(method, `${BASE}${path}`, { ...f.world.as(person.userId), body, ...extra });
const input = (f: Fixture) => ({ effectiveDate: '2026-10-19', fields: { departmentId: f.department } });
const revisionOf = async (f: Fixture, person: Person) =>
  (await f.world.json<{ employee: { revision: number } }>(await call(f, person, '/profile'))).employee.revision;
const submit = async (f: Fixture, person: Person, key = randomUUID(), revision?: number) =>
  call(f, person, '/transfer', 'POST', input(f), {
    ifMatch: revision ?? (await revisionOf(f, person)),
    idempotencyKey: key,
  });
/** 把标准员工身份的任职对象按钮设为指定集合（其余字段、数据操作不动）。 */
const setButtons = (f: Fixture, buttons: readonly string[]) =>
  putObject({ api: f.api, asAdmin: f.admin.asAdmin }, f.profileId, RECORD, (o) => ({
    ...o,
    buttons: [...BUTTONS, 'Employment.Delete']
      .filter((b) => buttons.includes(b))
      .map((buttonCode) => ({
        buttonCode,
        level: 'detail' as const,
      })),
  }));
const without = (button: string) => BUTTONS.filter((b) => b !== button);
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details?: { reason?: string; button?: string } } }).error;

async function footprint(f: Fixture) {
  return withTenant(f.world.db, f.world.tenant.id, async (tx) => ({
    transfers: (await tx.select().from(transferRequests)).length,
    ledger: (await tx.select().from(commandLedger)).length,
    audits: (await tx.select().from(auditEvents)).length,
  }));
}

describe('AC-TRF-39 E2：直接建的租户（兜底）与装有标准员工身份的租户，本人调动同输出', () => {
  const observe = async (f: Fixture) => {
    const person = await f.world.person('观察员工', f.department);
    const profile = await f.world.json<{ record: Record<string, unknown>; employee: Record<string, unknown> }>(
      await call(f, person, '/profile'),
    );
    const preview = await f.world.json<Record<string, unknown>>(
      await call(f, person, '/transfer/preview', 'POST', input(f)),
    );
    const references: Record<string, number> = {};
    for (const code of ['departmentId', 'directManagerId', 'postId', 'levelId', 'sequenceId', 'reasonCode', 'place'])
      references[code] = (await call(f, person, `/transfer/references/${code}?asOf=2026-10-19`)).status;
    const writes = {
      readonlyPostId: (await call(f, person, '/transfer/preview', 'POST', { ...input(f), fields: { postId: null } }))
        .status,
      invisibleField: (
        await call(f, person, '/transfer/preview', 'POST', {
          ...input(f),
          fields: { departmentId: f.department, remarks: '越权' },
        })
      ).status,
    };
    const created = await submit(f, person);
    const submitted = (await created.json()) as { status?: string };
    return JSON.parse(
      JSON.stringify({
        profileKeys: Object.keys(profile.record ?? {}).sort(),
        preview,
        references,
        writes,
        submitStatus: created.status,
        businessStatus: submitted.status,
      }).replace(uuid, '<id>'),
    ) as unknown;
  };

  it('GET /profile 披露字段、预览表单 / 字段 / 原因、候选接口状态码、越权写 403、提交 201 逐项相同（AC-TRF-39）', async () => {
    const fallback = await fixture('parity-fallback', false);
    const standard = await fixture('parity-standard', true);
    const a = await observe(fallback);
    const b = await observe(standard);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ submitStatus: 201, businessStatus: 'in_review', writes: { readonlyPostId: 403 } });
  });
});

describe('AC-TRF-39 E5：标准行可调整、实时生效', () => {
  it('收紧标准行去掉 reasonCode → 预览隐藏原因；放开 → 恢复（AC-TRF-39）', async () => {
    const f = await fixture('parity-e5', true);
    const person = await f.world.person('调整员工', f.department);
    const save = (view: boolean) =>
      putObject({ api: f.api, asAdmin: f.admin.asAdmin }, f.profileId, RECORD, (o) => ({
        ...o,
        fields: o.fields.filter((x) => view || x.fieldCode !== 'reasonCode'),
      }));
    expect((await save(false)).status).toBe(200);
    const hidden = await f.world.json(await call(f, person, '/transfer/preview', 'POST', input(f)));
    expect(hidden).toMatchObject({ basicFieldModes: { reasonCode: 'hidden' }, reasons: [] });
    // 放回字段：整对象替换，用开通默认值重存
    const defaults = EMP_DEF.objects.find((o) => o.objectCode === RECORD)!;
    expect(
      (await putObject({ api: f.api, asAdmin: f.admin.asAdmin }, f.profileId, RECORD, () => defaults)).status,
    ).toBe(200);
    const shown = await f.world.json<{ basicFieldModes: Record<string, string> }>(
      await call(f, person, '/transfer/preview', 'POST', input(f)),
    );
    expect(shown.basicFieldModes.reasonCode).not.toBe('hidden');
  });
});

describe.each(BUTTONS)('AC-TRF-39 6a：关闭本人调动按钮 %s（DEC-402②）', (button) => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture(`parity-6a-${button.replace('.', '-')}`.toLowerCase(), true);
  });
  // 某个用例中途失败时也把三个按钮勾回，避免后续用例带着上一个用例的撤权状态而连环失败
  afterEach(async () => {
    await setButtons(f, BUTTONS);
  });

  it('预览与提交（新命令 ID）都 403 SELF_TRANSFER_BUTTON_DENIED，无申请 / 台账 / 业务变更审计；勾回即恢复（AC-TRF-39）', async () => {
    const person = await f.world.person(`首次-${button}`, f.department);
    const revision = await revisionOf(f, person);
    expect((await setButtons(f, without(button))).status).toBe(200);
    const before = await footprint(f);

    const preview = await call(f, person, '/transfer/preview', 'POST', input(f));
    expect(preview.status).toBe(403);
    expect(await errorOf(preview)).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'SELF_TRANSFER_BUTTON_DENIED', button },
    });
    const denied = await submit(f, person, randomUUID(), revision);
    expect(denied.status).toBe(403);
    expect(await errorOf(denied)).toMatchObject({ details: { reason: 'SELF_TRANSFER_BUTTON_DENIED', button } });
    const after = await footprint(f);
    expect(after.transfers).toBe(before.transfers);
    expect(after.ledger).toBe(before.ledger);
    expect(after.audits).toBe(before.audits);
    expect(await f.world.json(await call(f, person, '/applications'))).toMatchObject({ items: [] });

    expect((await setButtons(f, BUTTONS)).status).toBe(200);
    expect((await call(f, person, '/transfer/preview', 'POST', input(f))).status).toBe(200);
    const ok = await f.world.json<{ status: string }>(await submit(f, person, randomUUID(), revision), 201);
    expect(ok.status).toBe('in_review');
  });

  it('直接重放：命令 K 成功后关闭按钮，同一 K 同一请求体再提交 → 403，不是原 201，无新增申请（AC-TRF-39）', async () => {
    const person = await f.world.person(`重放-${button}`, f.department);
    const key = randomUUID();
    const revision = await revisionOf(f, person);
    const first = await submit(f, person, key, revision);
    expect(first.status).toBe(201);
    // 对照：不撤权时同键重放得到原结果
    const same = await submit(f, person, key, revision);
    expect(same.status).toBe(201);
    expect(((await same.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);

    expect((await setButtons(f, without(button))).status).toBe(200);
    const before = await footprint(f);
    const replay = await submit(f, person, key, revision);
    expect(replay.status).toBe(403);
    expect(await errorOf(replay)).toMatchObject({ details: { reason: 'SELF_TRANSFER_BUTTON_DENIED', button } });
    expect(await footprint(f)).toEqual(before);
    expect((await setButtons(f, BUTTONS)).status).toBe(200);
  });

  it('失败后回查：败者执行失败、台账已有同键结果，再关按钮 → 回查 403；对照组不撤权 → 重放胜者的 201（AC-TRF-39）', async () => {
    const run = async (revoke: boolean) => {
      const person = await f.world.person(`回查-${button}-${revoke}`, f.department);
      const key = randomUUID();
      const revision = await revisionOf(f, person);
      const loser: Loser = {
        winner: () => submit(f, person, key, revision),
        afterLoserTx: async () => {
          if (revoke) expect((await setButtons(f, without(button))).status).toBe(200);
        },
      };
      hooks.loser = loser;
      const res = await submit(f, person, key, revision);
      expect(loser.winnerResponse?.status).toBe(201);
      return { res, winner: loser.winnerResponse! };
    };
    const control = await run(false);
    expect(control.res.status).toBe(201);
    expect(((await control.res.json()) as { id: string }).id).toBe(
      ((await control.winner.json()) as { id: string }).id,
    );

    const revoked = await run(true);
    expect(revoked.res.status).toBe(403);
    expect(await errorOf(revoked.res)).toMatchObject({ details: { reason: 'SELF_TRANSFER_BUTTON_DENIED', button } });
    expect((await setButtons(f, BUTTONS)).status).toBe(200);
  });
});

describe('AC-TRF-39 6a 补充：并集与不外溢', () => {
  it('用户另持有带 Transfer.Self 的身份时，员工身份去掉它仍可用（并集）；员工身份多勾 Employment.Delete 不替代缺失的按钮（AC-TRF-39）', async () => {
    const f = await fixture('parity-union', true);
    const person = await f.world.person('并集员工', f.department);
    expect((await setButtons(f, without('Transfer.Self'))).status).toBe(200);
    expect((await call(f, person, '/transfer/preview', 'POST', input(f))).status).toBe(403);

    const extra = await createProfile(f.admin, 'transfer_self_holder');
    expect(
      (
        await setObjectPermission(
          f.admin,
          extra,
          {
            dataOperations: { create: true, update: false, delete: false },
            fields: [],
            buttons: [{ buttonCode: 'Transfer.Self', level: 'detail' }],
          },
          RECORD,
        )
      ).status,
    ).toBe(200);
    await makeGrantable(f.admin, [extra.id]);
    expect((await grant(f.admin, person.userId, extra.id)).status).toBe(201);
    expect((await call(f, person, '/transfer/preview', 'POST', input(f))).status).toBe(200);

    const other = await f.world.person('多勾按钮员工', f.department);
    expect((await setButtons(f, [...without('Employment.Submit'), 'Employment.Delete'])).status).toBe(200);
    const res = await call(f, other, '/transfer/preview', 'POST', input(f));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).details).toMatchObject({ button: 'Employment.Submit' });
  });
});
