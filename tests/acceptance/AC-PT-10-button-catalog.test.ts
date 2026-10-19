/** DEC-642 / #447：按钮用真实目录判定，不能只按编码放行授权替身。 */
import { buttonResource, decide, MODULE_OBJECTS, type ButtonLevel, type PermissionSubject } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { httpWorld, restricted } from './AC-PT-http-support.js';

const database = useTestDb();
const definition = MODULE_OBJECTS.employmentRecord;
const code = 'Employment.PartTimeBatchEnd';
function subject(level?: ButtonLevel): PermissionSubject {
  return {
    adminRoles: [],
    objectPermissions: [
      {
        objectCode: definition.code,
        profileApps: [definition.application],
        dataOperations: { create: false, update: true, delete: false },
        fields: [{ fieldCode: 'endDate', view: true, edit: true }],
        buttons: level ? [{ buttonCode: code, level }] : [],
      },
    ],
  };
}

describe('AC-PT-10 DEC-642 批量结束列表级授权', () => {
  it.each(['list', 'detail', undefined] as const)('授权层级 %s：真实目录 + HTTP 首次与重放', async (level) => {
    const w = await httpWorld(database().db, `catalog-${level ?? 'none'}`);
    const record = await w.make({ endDate: '2026-12-31' });
    const who = subject(level);
    const asked: string[] = [];
    const authorize = restricted({
      deny: (query) => {
        if (query.action !== 'object.button') return false;
        asked.push(String(query.resource));
        return !decide(who, query, objectCatalog);
      },
    });
    const body = { items: [{ recordId: record.id, revision: record.revision }], endDate: '2026-10-15' };
    const send = w.as(authorize);
    const options = { body, idempotencyKey: `catalog-${level ?? 'none'}` };
    const response = await send('POST', '/part-times/batch-end', options);
    expect(response.status, await response.clone().text()).toBe(level === 'list' ? 200 : 403);
    expect(new Set(asked)).toEqual(new Set([buttonResource(definition.code, code, 'list')]));
    if (level !== 'list') {
      expect(await w.headRevision(record.id)).toBe(1);
      return;
    }
    expect(await response.json()).toMatchObject({
      total: 1,
      succeeded: 1,
      failed: 0,
      items: [{ id: record.id, revision: 2 }],
    });
    expect((await send('POST', '/part-times/batch-end', options)).status).toBe(200);
    const revoked = w.as(
      restricted({ deny: (q) => q.action === 'object.button' && !decide(subject(), q, objectCatalog) }),
    );
    expect((await revoked('POST', '/part-times/batch-end', options)).status).toBe(403);
    expect(await w.headRevision(record.id)).toBe(2);
  });
});
