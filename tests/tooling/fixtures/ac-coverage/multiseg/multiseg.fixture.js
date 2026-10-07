// DEC-291②：多段 AC 编号（如 AC-PRM-FW-01、区间 AC-PRM-FW-01～07）与单段编号混写；非法写法报错、不吞掉。
import { it } from 'vitest';

const fn = () => {};

it('AC-PRM-FW-01 多段单号', fn);
it('AC-PRM-FW-02～04 多段区间', fn);
it('AC-PRM-01～02 与 AC-PRM-FW-05 / 06 混写', fn);
it('AC-360-FW-01 数字模块加多段', fn);
it('AC-PRM 是模块统称，不是编号', fn);
it('AC-PRM-FW-1 一位序号', fn);
it('AC-PRM--03 空段', fn);
it('AC-EMP-16-SUB-05 连写', fn);
it('AC-PRM-03～AC-PRM-05 区间终点写全称', fn);
