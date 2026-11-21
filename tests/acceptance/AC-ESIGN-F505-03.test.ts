import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { SCENES, sharedWorld } from './AC-ESIGN-F505-s2-support.js';

const db = useTestDb();
const defaults = { validityDays: 2, remindBeforeExpiry: false, revision: 0 };

it('AC-03 新场景的默认值、边界、并发版本和期限快照分别隔离', async () => {
  const w = await sharedWorld(db().db, 'settings');
  const old = await w.fixture('offer', await w.template());
  for (const scene of SCENES) {
    const path = `/scenes/${scene}`;
    expect(await json(await w.call('GET', path))).toEqual({ scene, ...defaults });
    for (const validityDays of [1, 31]) {
      await reason(
        await w.call('PUT', path, { ifMatch: 0, body: { validityDays, remindBeforeExpiry: true } }),
        'VALIDATION_FAILED',
        400,
      );
    }
  }
  const path = '/scenes/offer';
  const body = { validityDays: 30, remindBeforeExpiry: true };
  expect(await json(await w.call('PUT', path, { ifMatch: 0, body }))).toEqual({ scene: 'offer', revision: 1, ...body });
  await reason(await w.call('PUT', path, { ifMatch: 0, body }), 'REVISION_CONFLICT');
  expect(await json(await w.call('GET', path))).toEqual({ scene: 'offer', revision: 1, ...body });
  for (const scene of ['entry', 'transfer']) {
    expect(await json(await w.call('GET', `/scenes/${scene}`))).toEqual({ scene, ...defaults });
  }
  expect(await w.taskRow(old.id)).toEqual(old);
});
