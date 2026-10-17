// describe 层级：编号取各级 describe 标题与用例标题的并集；skip / todo 由 Vitest 继承。
import { describe, it } from 'vitest';

const fn = () => {};

describe.each(['AC-DEMO-20'])('%s', () => it('child', fn));
describe.for(['AC-DEMO-21'])('%s', () => it('child', fn));
describe('AC-DEMO-22', () => describe('inner', () => it('AC-DEMO-23 leaf', fn)));
describe.todo('AC-DEMO-24', () => it('child', fn));
describe('AC-DEMO-25', { skip: true }, () => it('child', fn));
describe.skip('AC-DEMO-26', () => it('child', fn));
