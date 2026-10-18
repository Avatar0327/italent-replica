// 附录 C 夹具 15：被导入的 helper 在循环里同一调用点注册，两档顺序相反。
import { marker } from '../marker.js';
import { register } from './register.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

for (const row of pg ? ['B', 'A'] : ['A', 'B'])
  register(mark, 'AC-ID-15 同名用例', row, pg ? row === 'B' : row === 'A');
