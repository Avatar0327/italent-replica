import { randomUUID } from 'node:crypto';
import {
  and,
  auditEvents,
  desc,
  eq,
  establishmentOutbox,
  establishmentSchemeObjects,
  establishmentSchemeVersions,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { updateScheme } from '../../apps/api/src/modules/establishment/schemes.js';
import { lockEstablishment } from '../../apps/api/src/modules/establishment/store.js';
import { establishmentSession, EST_NOW } from './AC-EST-support.js';

const testDb = useTestDb();
const bootstrapAction = 'establishment.scheme.default.create';

describe('REQ-EST-001 预置默认方案在首个写事务初始化', () => {
  it('读取不建方案，写入创建默认版本并以实际操作人与命令同事务记录审计和事件', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-default');
    const ctx = context(session);
    const initial = await withTenant(db, session.tenant.id, (tx) => tx.select().from(establishmentSchemeObjects));
    expect(initial).toEqual([]);

    await withTenant(db, session.tenant.id, (tx) => lockEstablishment(tx, ctx));
    await withTenant(db, session.tenant.id, async (tx) => {
      const objects = await tx.select().from(establishmentSchemeObjects);
      expect(objects).toHaveLength(1);
      const versions = await tx.select().from(establishmentSchemeVersions);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        schemeId: objects[0]!.id,
        code: 'DEFAULT',
        name: '默认方案',
        cycle: 'annual',
        maintenanceMode: 'local',
        subdivision: 'none',
        unmatchedPolicy: 'organization',
        startMonth: 1,
        startDate: '0001-01-01',
        stopDate: '9999-12-31',
        enabled: true,
      });
      const audit = await tx.select().from(auditEvents).where(eq(auditEvents.action, bootstrapAction));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: session.user.id, commandId: ctx.commandId });
      const outbox = await tx
        .select()
        .from(establishmentOutbox)
        .where(eq(establishmentOutbox.eventType, bootstrapAction));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.payload).toMatchObject({ commandId: ctx.commandId });
    });
  });

  it('重复写入复用稳定ID，停用后仍不重建默认方案', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-default-stop');
    await withTenant(db, session.tenant.id, (tx) => lockEstablishment(tx, context(session)));
    const [original] = await withTenant(db, session.tenant.id, (tx) => tx.select().from(establishmentSchemeObjects));
    expect(original).toBeDefined();
    await withTenant(db, session.tenant.id, (tx) =>
      updateScheme(tx, context(session, 1), original!.id, { enabled: false, effectiveDate: '2026-10-01' }),
    );
    await withTenant(db, session.tenant.id, (tx) => lockEstablishment(tx, context(session)));

    await withTenant(db, session.tenant.id, async (tx) => {
      const objects = await tx.select().from(establishmentSchemeObjects);
      expect(objects.map((object) => object.id)).toEqual([original!.id]);
      const [latest] = await tx
        .select()
        .from(establishmentSchemeVersions)
        .where(eq(establishmentSchemeVersions.schemeId, original!.id))
        .orderBy(desc(establishmentSchemeVersions.versionNo))
        .limit(1);
      expect(latest).toMatchObject({ enabled: false, versionNo: 2 });
      const audit = await tx.select().from(auditEvents).where(eq(auditEvents.action, bootstrapAction));
      expect(audit).toHaveLength(1);
    });
  });

  it('写事务失败时默认对象、业务版本、审计和outbox一起回滚', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-default-rollback');
    const ctx = context(session);
    await expect(
      withTenant(db, session.tenant.id, async (tx) => {
        await lockEstablishment(tx, ctx);
        const objects = await tx.select().from(establishmentSchemeObjects);
        expect(objects).toHaveLength(1);
        throw new Error('回滚首次编制写事务');
      }),
    ).rejects.toThrow('回滚首次编制写事务');

    await withTenant(db, session.tenant.id, async (tx) => {
      expect(await tx.select().from(establishmentSchemeObjects)).toEqual([]);
      expect(await tx.select().from(establishmentSchemeVersions)).toEqual([]);
      expect(
        await tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.action, bootstrapAction), eq(auditEvents.commandId, ctx.commandId))),
      ).toEqual([]);
      expect(
        await tx.select().from(establishmentOutbox).where(eq(establishmentOutbox.eventType, bootstrapAction)),
      ).toEqual([]);
    });
  });
});

function context(session: Awaited<ReturnType<typeof establishmentSession>>, expectedRevision = 0) {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    commandId: randomUUID(),
    now: EST_NOW,
    timezone: session.tenant.timezone,
    expectedRevision,
  };
}
