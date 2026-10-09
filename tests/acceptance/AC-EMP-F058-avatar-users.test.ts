/** F-058 复审 P1：账号头像必须关联目标账号，覆盖用户写入口与真实任职自动建档链路。 */
import { randomUUID } from 'node:crypto';
import { and, auditEvents, eq, revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { AvatarReference } from './AC-EMP-F058-avatar-support.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { addMember, BASE, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { hrApi, syntheticEmail, type TenantUserBody } from './AC-PRM-users-support.js';
import { imageFixture } from './AC-TC-model-image-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
type AvatarUser = TenantUserBody & { avatar: AvatarReference | null };

async function ok<T>(response: Promise<Response> | Response, status = 200): Promise<T> {
  const res = await response;
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json() as Promise<T>;
}

async function world() {
  return seedPermissionWorld(testDb().db);
}

async function upload(w: PermissionWorld, userId: string): Promise<AvatarReference> {
  const options = { user: userId, tenant: w.tenant.id };
  const base = '/api/tenant/account/avatar';
  const state = await ok<{ revision: number }>(w.api.request('GET', base, options));
  const image = imageFixture();
  const registered = await ok<{ revision: number; attachment: { id: string } }>(
    w.api.request('POST', `${base}/attachments`, {
      ...options,
      ifMatch: state.revision,
      body: image.metadata,
    }),
    201,
  );
  const uploaded = await ok<{ avatar: AvatarReference }>(
    w.api.request('POST', `${base}/attachments/${registered.attachment.id}/upload`, {
      ...options,
      ifMatch: registered.revision,
      body: { base64: image.base64 },
    }),
  );
  return uploaded.avatar;
}

function register(w: PermissionWorld, email: string, idempotencyKey = randomUUID()) {
  return w.api.request('POST', `${BASE}/users`, {
    ...w.asAdmin,
    idempotencyKey,
    body: { email, displayName: '合成外部用户', userType: 'external', businessIdentity: '合成顾问' },
  });
}

async function audit(w: PermissionWorld, commandId: string, action: string) {
  const events = await withTenant(w.db, w.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.commandId, commandId), eq(auditEvents.action, action))),
  );
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('AC-EMP-F058-P1 用户读取的头像逐个关联', () => {
  it.each(['列表', '详情'])('只有 A 有头像时，%s 中 B 的头像为空', async (entry) => {
    const w = await world();
    const b = await addMember(w, '没有头像的 B');
    const aAvatar = await upload(w, w.admin.id);
    if (entry === '列表') {
      const users = await ok<{ items: AvatarUser[] }>(w.api.request('GET', `${BASE}/users?limit=200`, w.asAdmin));
      expect(users.items.find((u) => u.userId === w.admin.id)?.avatar).toEqual(aAvatar);
      expect(users.items.find((u) => u.userId === b.id)?.avatar).toBeNull();
    } else {
      const bView = await ok<AvatarUser>(w.api.request('GET', `${BASE}/users/${b.id}`, w.asAdmin));
      expect(bView.avatar).toBeNull();
    }
  });

  it.each(['列表', '逐个详情'])('A、B 均有头像时，%s 各自对应且不返回 500', async (entry) => {
    const w = await world();
    const b = await addMember(w, '有头像的 B');
    const aAvatar = await upload(w, w.admin.id);
    const bAvatar = await upload(w, b.id);
    expect(aAvatar.id).not.toBe(bAvatar.id);
    if (entry === '列表') {
      const users = await ok<{ items: AvatarUser[] }>(w.api.request('GET', `${BASE}/users?limit=200`, w.asAdmin));
      expect(users.items.find((u) => u.userId === w.admin.id)?.avatar).toEqual(aAvatar);
      expect(users.items.find((u) => u.userId === b.id)?.avatar).toEqual(bAvatar);
    } else {
      for (const [userId, avatar] of [
        [w.admin.id, aAvatar],
        [b.id, bAvatar],
      ] as const) {
        expect(await ok<AvatarUser>(w.api.request('GET', `${BASE}/users/${userId}`, w.asAdmin))).toMatchObject({
          userId,
          avatar,
        });
      }
    }
  });
});

describe('AC-EMP-F058-P1 用户写入口不串用他人头像、不被多头像破坏', () => {
  it.each(['登记', '修改', '员工建档'])('两个账号有头像时，%s HTTP 写入口正常完成', async (entry) => {
    const w = await world();
    const b = await addMember(w, '多头像写入口 B');
    await upload(w, w.admin.id);
    await upload(w, b.id);
    if (entry === '登记') {
      expect((await ok<AvatarUser>(register(w, syntheticEmail('multiple-register')), 201)).avatar).toBeNull();
    } else if (entry === '修改') {
      const own = await ok<{ avatar: AvatarReference }>(
        w.api.request('GET', '/api/tenant/account/avatar', { user: b.id, tenant: w.tenant.id }),
      );
      expect(
        await ok<AvatarUser>(
          w.api.request('PUT', `${BASE}/users/${b.id}`, {
            ...w.asAdmin,
            ifMatch: 1,
            body: { userType: 'external', businessIdentity: '多头像修改' },
          }),
        ),
      ).toMatchObject({ userId: b.id, avatar: own.avatar });
    } else {
      const hr = hrApi(w);
      const employee = await hr.employee('多头像仍可建档', syntheticEmail('multiple-profile'));
      const users = await ok<{ items: AvatarUser[] }>(w.api.request('GET', `${BASE}/users?limit=200`, w.asAdmin));
      expect(users.items.find((u) => u.employeeId === employee.id)?.avatar).toBeNull();
    }
  });

  it('登记外部用户返回新账号自身的空头像', async () => {
    const w = await world();
    await upload(w, w.admin.id);
    const saved = await ok<AvatarUser>(register(w, syntheticEmail('avatar-register')), 201);
    expect(saved.avatar).toBeNull();
  });

  it('修改外部用户返回目标账号自身的空头像', async () => {
    const w = await world();
    const b = await addMember(w, '待登记的外部 B');
    await upload(w, w.admin.id);
    const saved = await ok<AvatarUser>(
      w.api.request('PUT', `${BASE}/users/${b.id}`, {
        ...w.asAdmin,
        ifMatch: 1,
        body: { userType: 'external', businessIdentity: '合成供应商' },
      }),
    );
    expect(saved.avatar).toBeNull();
  });

  it.each(['status', 'remove'])('两人有头像时，用户 %s 正常完成且回执不扩充头像字段', async (operation) => {
    const w = await world();
    const b = await addMember(w, `生命周期 ${operation}`);
    await upload(w, w.admin.id);
    await upload(w, b.id);
    const saved = await ok<Record<string, unknown>>(
      w.api.request('POST', `${BASE}/users/${b.id}/${operation}`, {
        ...w.asAdmin,
        ifMatch: 1,
        ...(operation === 'status' ? { body: { status: 'disabled' } } : {}),
      }),
    );
    expect(saved).toEqual({ userId: b.id, membershipStatus: 'revoked', membershipRevision: 2 });
    const member = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT status FROM tenant_memberships WHERE user_id=${b.id}::uuid`),
    );
    const rows = (Array.isArray(member) ? member : (member as { rows: { status: string }[] }).rows) as {
      status: string;
    }[];
    expect(rows).toEqual([{ status: 'revoked' }]);
  });

  it('员工建档带登录邮箱时，不把管理员头像冻结给新建用户', async () => {
    const w = await world();
    const hr = hrApi(w);
    await upload(w, w.admin.id);
    const commandId = randomUUID();
    await ok(
      hr.api.request('POST', '/api/tenant/employment/employees', {
        ...w.asAdmin,
        ifMatch: 0,
        idempotencyKey: commandId,
        body: { name: '建档合成员工', code: `AV_${randomUUID()}`, loginEmail: syntheticEmail('avatar-profile') },
      }),
      201,
    );
    const event = await audit(w, commandId, 'tenant_user.provision');
    const userId = (event.after as { userId: string }).userId;
    await upload(w, userId);
    expect(event.after).toMatchObject({ avatar: null, accountCreated: true });
    expect((await audit(w, commandId, 'tenant_user.provision')).after).toEqual(event.after);
  });
});

describe('AC-EMP-F058-P1 tenant_user 审计冻结目标头像引用', () => {
  it('登记审计冻结的是空头像，后来本人上传不改写历史审计', async () => {
    const w = await world();
    await upload(w, w.admin.id);
    const commandId = randomUUID();
    const saved = await ok<AvatarUser>(register(w, syntheticEmail('avatar-register-audit'), commandId), 201);
    await upload(w, saved.userId);
    const event = await audit(w, commandId, 'tenant_user.register_external');
    expect(event.after).toMatchObject({ userId: saved.userId, avatar: null });
  });

  it('修改审计的前后快照均冻结目标空头像，后来本人上传不改写历史审计', async () => {
    const w = await world();
    const b = await addMember(w, '修改审计的 B');
    await upload(w, w.admin.id);
    const commandId = randomUUID();
    await ok<AvatarUser>(
      w.api.request('PUT', `${BASE}/users/${b.id}`, {
        ...w.asAdmin,
        idempotencyKey: commandId,
        ifMatch: 1,
        body: { userType: 'external', businessIdentity: '合成审计顾问' },
      }),
    );
    await upload(w, b.id);
    const event = await audit(w, commandId, 'tenant_user.update');
    expect(event.before).toMatchObject({ userId: b.id, avatar: null });
    expect(event.after).toMatchObject({ userId: b.id, avatar: null });
  });

  it.each(['登记', '修改'])('%s 目标已有自己的头像时，审计冻结自己的引用而非其他人的引用', async (entry) => {
    const w = await world();
    const b = await addMember(w, entry === '登记' ? 'avatar-register-audit' : 'avatar-update-audit');
    const bAvatar = await upload(w, b.id);
    await upload(w, w.admin.id);
    const commandId = randomUUID();
    if (entry === '登记') {
      await revokeMembership(w.db, { tenantId: w.tenant.id, userId: b.id, expectedRevision: 1 }, cmd(w.admin.id));
      await ok<AvatarUser>(register(w, b.email, commandId), 201);
    } else {
      await ok<AvatarUser>(
        w.api.request('PUT', `${BASE}/users/${b.id}`, {
          ...w.asAdmin,
          idempotencyKey: commandId,
          ifMatch: 1,
          body: { userType: 'external', businessIdentity: '目标自己的头像' },
        }),
      );
    }
    const event = await audit(w, commandId, entry === '登记' ? 'tenant_user.register_external' : 'tenant_user.update');
    expect(event.after).toMatchObject({ userId: b.id, avatar: bAvatar });
    if (entry === '修改') expect(event.before).toMatchObject({ userId: b.id, avatar: bAvatar });
    await upload(w, b.id);
    expect((await audit(w, commandId, event.action)).after).toEqual(event.after);
  });
});

const employmentCases = (['hire', 'rehire', 'retire_rehire'] as const).flatMap((kind) =>
  (['new', 'existing'] as const).map((binding) => ({ kind, binding })),
);

describe('AC-EMP-F058-P1 ensureHiredAccount 的三类业务和两条绑定分支', () => {
  it.each(employmentCases)(
    '$kind / $binding：真实业务命令不会因多账号头像失败或冻结他人头像',
    async ({ kind, binding }) => {
      const w = await world();
      const hr = hrApi(w);
      const email = syntheticEmail(`avatar-${kind}-${binding}`);
      const employee = await hr.employee(`头像 ${kind} ${binding}`, binding === 'existing' ? email : undefined);
      let revision = employee.revision;
      if (kind !== 'hire') {
        const hired = await ok<EmploymentBusiness>(
          hr.hire(employee, await hr.org('历史入职部门'), {
            effectiveDate: '2026-08-01',
            loginEmail: binding === 'existing' ? email : syntheticEmail('legacy-bound'),
          }),
          201,
        );
        const ending = await ok<EmploymentBusiness>(
          hr.api.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
            ...w.asAdmin,
            ifMatch: hired.employeeRevision,
            body: { kind: kind === 'rehire' ? 'leave' : 'retirement', mode: 'direct', lastWorkDate: '2026-08-31' },
          }),
          201,
        );
        revision = ending.employeeRevision;
        if (binding === 'new') {
          // 模拟已导入任职历史、账号对应尚未初始化的存量人员；待测新业务仍走真实 HTTP 与自动建档端口。
          await w.db.execute(sql`DELETE FROM permission_user_person_links
          WHERE tenant_id=${w.tenant.id} AND employee_id=${employee.id}::uuid`);
        }
      }
      const target = binding === 'new' ? await addMember(w, `avatar-new-binding-${kind}`) : null;
      const bound = await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employee.id}::uuid`),
      );
      const links = (Array.isArray(bound) ? bound : (bound as { rows: { user_id: string }[] }).rows) as {
        user_id: string;
      }[];
      expect(links).toHaveLength(binding === 'new' ? 0 : 1);
      const targetId = target?.id ?? links[0]!.user_id;
      const targetEmail = target?.email ?? email;
      const targetAvatar = await upload(w, targetId);
      const adminAvatar = await upload(w, w.admin.id);
      expect(targetAvatar.id).not.toBe(adminAvatar.id);
      const commandId = randomUUID();
      const result = await ok<EmploymentBusiness>(
        hr.api.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
          ...w.asAdmin,
          ifMatch: revision,
          idempotencyKey: commandId,
          body: { kind, mode: 'direct', effectiveDate: '2026-09-01', loginEmail: targetEmail, fields: {} },
        }),
        201,
      );
      expect(result.status).toBe('effective');
      expect(await ok<AvatarUser>(w.api.request('GET', `${BASE}/users/${targetId}`, w.asAdmin))).toMatchObject({
        userId: targetId,
        employeeId: employee.id,
        avatar: targetAvatar,
      });
      if (binding === 'new') {
        const event = await audit(w, commandId, 'tenant_user.provision');
        expect(event.after).toMatchObject({ userId: targetId, employeeId: employee.id, avatar: targetAvatar });
        await upload(w, targetId);
        expect((await audit(w, commandId, 'tenant_user.provision')).after).toEqual(event.after);
      }
    },
  );
});
