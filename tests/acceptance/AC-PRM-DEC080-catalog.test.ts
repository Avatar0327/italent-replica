import { describe, expect, it } from 'vitest';
import { decide, MODULE_OBJECTS, ObjectCatalog, type PermissionSubject } from '@italent/domain';

describe('DEC-080 real module catalogs and fail-closed writes', () => {
  it('registers actual fields and buttons, with system fields never editable', () => {
    for (const definition of Object.values(MODULE_OBJECTS)) {
      expect(definition.fields.length, definition.code).toBeGreaterThan(0);
      expect(definition.buttons.length, definition.code).toBeGreaterThan(0);
      expect(definition.fields.find((f) => f.code === 'id')?.system, definition.code).toBe(true);
    }
  });

  it('does not turn an omitted write field list into an empty valid write', () => {
    const definition = MODULE_OBJECTS.organization;
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [
        {
          objectCode: definition.code,
          profileApps: [definition.application],
          dataOperations: { create: false, update: true, delete: false },
          fields: [],
          buttons: [],
        },
      ],
    };
    const catalog = new ObjectCatalog(Object.values(MODULE_OBJECTS));
    expect(decide(subject, { action: 'tenant.org.write' }, catalog)).toBe(false);
    expect(decide(subject, { action: 'tenant.org.create', fields: [] }, catalog)).toBe(false);
    expect(decide(subject, { action: 'tenant.org.delete' }, catalog)).toBe(false);
  });
});
