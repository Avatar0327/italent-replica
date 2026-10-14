import { expect, it } from 'vitest';
import { annotations } from '../../apps/web/src/annotations/index.js';
import { notes as qualificationNotes } from '../../apps/web/src/qualification/annotations.js';
import { notes as selfServiceNotes } from '../../apps/web/src/self-service/annotations.js';
import { notes as talentNotes } from '../../apps/web/src/talent/annotations.js';

it.each(Object.entries({ ...qualificationNotes, ...selfServiceNotes, ...talentNotes }))(
  'AC-FE-R3a 增量合并保留双方注释 %s',
  (id, note) => {
    expect(annotations[id]).toEqual(note);
    expect(annotations[id]?.decisions).toContain('DEC-456');
  },
);
