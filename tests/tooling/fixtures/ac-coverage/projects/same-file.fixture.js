// #102 第 3 轮附录 A 夹具 33：同一文件被两个具名 project 收集，同一档里“文件 + 名称路径 + 位置”相同的
// 注册（含父套件）各出现两次。旧实现只在单个 module 内查重复，join 时只取第一条，丢掉了第二条注册。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const project = process.env.AC_FIXTURE_PROJECT;

it('AC-PJ-33 两个 project 都收集', () => mark(`33-${project}`));
describe('两个 project 都收集的父套件', () => {
  it('AC-PJ-34 子用例', () => mark(`34-${project}`));
});
