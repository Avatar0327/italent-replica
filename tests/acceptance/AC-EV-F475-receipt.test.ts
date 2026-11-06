import { describe, expect, it } from 'vitest';
import * as model from '../../apps/web/src/evaluation/model.js';

const check = (receipt: unknown, revision: number, id?: string) => {
  const validate = Reflect.get(model, 'requireEvaluationReceipt');
  expect(validate, '评定提交必须校验实际命令 revision 的回执').toBeTypeOf('function');
  return validate(receipt, revision, id);
};
describe('AC-EV F-475 评定表单真实回执', () => {
  it('接受同对象实际命令版本加一，包括冲突后重提的新版本', () => {
    expect(check({ id: 'synthetic', revision: 8 }, 7, 'synthetic')).toEqual({ id: 'synthetic', revision: 8 });
  });
  it.each([
    undefined,
    { id: 'synthetic' },
    { id: 'other', revision: 8 },
    { id: 'synthetic', revision: 7 },
    { id: 'synthetic', revision: 9 },
  ])('拒绝无法证明本次保存的回执 %j', (receipt) => {
    expect(() => check(receipt, 7, 'synthetic')).toThrow();
  });
});
