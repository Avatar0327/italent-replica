import { expect, it } from 'vitest';
import { annotations } from '../../apps/web/src/annotations/index.js';
import { qualificationNotes } from '../../apps/web/src/annotations/qualification.js';
import { selfServiceNotes } from '../../apps/web/src/annotations/self-service.js';
import { talentNotes } from '../../apps/web/src/annotations/talent.js';

it.each(Object.entries({ ...qualificationNotes, ...selfServiceNotes, ...talentNotes }))(
  'AC-FE-R3a 增量合并保留双方注释 %s',
  (id, note) => {
    expect(annotations[id]).toEqual(note);
    expect(annotations[id]?.decisions).toContain('DEC-456');
  },
);
