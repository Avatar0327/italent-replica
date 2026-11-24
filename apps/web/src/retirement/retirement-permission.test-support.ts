import type { ObjectDefinition } from '@italent/domain';

export function retirementObjectGrant(definition: ObjectDefinition) {
  return {
    dataOperations: { create: true, update: true, delete: false },
    fields: definition.fields.map(({ code, system }) => ({ fieldCode: code, view: true, edit: !system })),
    buttons: definition.buttons.map(({ code, level }) => ({ buttonCode: code, level })),
  };
}
