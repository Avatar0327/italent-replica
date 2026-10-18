// 附录 B 条件链（v293 / v294 型）：PGlite 档外层被跳过、only 残留；PG 档外层运行、only 生效并被 Vitest 拒绝。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

const pg = Boolean(process.env.AC_FIXTURE_PG);

(pg ? describe : describe.skip)('外', () => describe.only('内', () => it('AC-ONLY-09', never('09'))));
it('control', () => mark('control'));
