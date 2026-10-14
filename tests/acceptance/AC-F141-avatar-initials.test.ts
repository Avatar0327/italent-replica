/**
 * F-141 ⑦（DEC-500）：头像缩写。演示姓名带“（演示）”之类的标注，之前取末尾两字，显示成“示）”。
 * 先去掉括号及括号里的标注，再取字；英文名仍取首尾词的首字母。
 */
import { describe, expect, it } from 'vitest';
import { avatarInitials } from '../../apps/web/src/shared/avatar-initials.js';

describe('AC-F141-avatar-initials 头像缩写（DEC-500⑦）', () => {
  it('普通中文姓名：取末尾两字', () => {
    expect(avatarInitials('张清勇')).toBe('清勇');
    expect(avatarInitials('欧阳娜娜')).toBe('娜娜');
    expect(avatarInitials('李明')).toBe('李明');
    expect(avatarInitials('王')).toBe('王');
  });

  it('带括号标注的姓名：先去标注（全角、半角、方括号、书名号）再取字', () => {
    expect(avatarInitials('平台研发员工甲（演示）')).toBe('工甲');
    expect(avatarInitials('平台研发部经理(演示)')).toBe('经理');
    expect(avatarInitials('数据分析师（演示）')).toBe('析师');
    expect(avatarInitials('张三【测试】')).toBe('张三');
    expect(avatarInitials('张三 [演示]')).toBe('张三');
  });

  it('英文名：首尾词首字母大写；单词取一个字母；英文名带标注也先去标注', () => {
    expect(avatarInitials('john smith')).toBe('JS');
    expect(avatarInitials('Mary Ann Lee')).toBe('ML');
    expect(avatarInitials('alice')).toBe('A');
    expect(avatarInitials('Bob Stone (demo)')).toBe('BS');
  });

  it('空值与只有标注：不报错，退回可显示的内容', () => {
    expect(avatarInitials('')).toBe('');
    expect(avatarInitials('   ')).toBe('');
    expect(avatarInitials('（演示）')).toBe('演示');
  });
});
