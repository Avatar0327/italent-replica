import { useTestDb } from '@italent/testkit';
import { it } from 'vitest';
import { expectHidden, resultWorld, SOURCE_OBJECT } from './AC-CMD-F553-support.js';

const db = useTestDb();

it.each([
  ['02', 'offer'],
  ['03', 'entry'],
] as const)('AC-CMD-F553-%s %s 撤销来源编辑权后回查不交出原回执', async (_ac, scene) => {
  const world = await resultWorld(db().db, scene);
  const response = await world.call({
    deny: ({ resource, action }) => resource === SOURCE_OBJECT[scene] && action === 'object.update',
  });
  await expectHidden(response, [403, 404]);
});
