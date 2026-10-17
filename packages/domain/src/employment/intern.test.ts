import { describe, expect, it } from 'vitest';
import { INTERN_VIEWS } from './intern.js';

describe('BE-6a 实习生纯函数', () => {
  it('四视图编码固定', () => {
    expect(INTERN_VIEWS).toEqual(['interning', 'converting', 'converted', 'left']);
  });
});
