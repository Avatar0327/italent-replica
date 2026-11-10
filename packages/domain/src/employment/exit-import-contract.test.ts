import { describe, expect, it } from 'vitest';
import {
  EXIT_IMPORT_BODY_LIMIT,
  EXIT_IMPORT_COLUMNS,
  EXIT_IMPORT_FILE_TTL_DAYS,
  EXIT_IMPORT_HISTORY_PAGE_SIZE,
  EXIT_IMPORT_MAX_ATTEMPTS,
  EXIT_IMPORT_REASONS,
  exitImportErrorText,
  normalizeExitImportDate,
} from './exit-import-contract.js';
import { EXIT_IMPORT_ROW_LIMIT, duplicateEmailRows } from './exit-import.js';

const NAMES = [
  '导入结果', '*姓名', '*电子邮件', '*部门编码', '*入职日期', '职位名称', '职务名称', '职级', '参加工作日期', '工作地点',
  '身份证号', '手机号码', '个人邮箱', '性别', '出生日期', '民族', '政治面貌', '户籍所在地', '籍贯', '毕业学校', '专业',
  '*最后工作日', '离职类型', '离职原因', '离职后去向', '离职说明',
]; // prettier-ignore
const KEYS = [
  'name', 'email', 'departmentCode', 'entryDate', 'positionName', 'postName', 'levelName', 'workDate', 'place',
  'idNumber', 'mobilePhone', 'personalEmail', 'gender', 'birthday', 'nation', 'politicalStatus', 'householdAddress',
  'registAddress', 'school', 'major', 'lastWorkDate', 'exitTypeName', 'exitReasonName', 'whereaboutsName', 'exitNote',
]; // prettier-ignore

describe('F-493 S2 导入契约常量', () => {
  it('上限类常量；单批行数上限 1000（S3a）', () => {
    expect(EXIT_IMPORT_BODY_LIMIT).toBe(1024 * 1024);
    expect(EXIT_IMPORT_MAX_ATTEMPTS).toBe(5);
    expect(EXIT_IMPORT_FILE_TTL_DAYS).toBe(15);
    expect(EXIT_IMPORT_HISTORY_PAGE_SIZE).toBe(15);
    expect(EXIT_IMPORT_ROW_LIMIT).toBe(1000);
  });

  it('模板 26 列：列字母 A～Z、列名原文（含「*」）、必填 B C D E V、请求体键齐全且唯一', () => {
    expect(EXIT_IMPORT_COLUMNS).toHaveLength(26);
    expect(EXIT_IMPORT_COLUMNS.map((c) => c.letter).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(EXIT_IMPORT_COLUMNS.map((c) => c.name)).toEqual(NAMES);
    expect(EXIT_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.letter)).toEqual(['B', 'C', 'D', 'E', 'V']);
    expect(EXIT_IMPORT_COLUMNS.map((c) => c.key)).toEqual([null, ...KEYS]);
    // 必填标识只靠列名前的「*」，两者必须一致
    for (const column of EXIT_IMPORT_COLUMNS) expect(column.name.startsWith('*'), column.letter).toBe(column.required);
  });
});

describe('F-493 日期规整（设计 §3.2：三种格式）', () => {
  it.each([
    ['2023-03-01', '2023-03-01'],
    ['2023/03/01', '2023-03-01'],
    ['2023/3/1', '2023-03-01'],
    [' 2024/2/29 ', '2024-02-29'],
  ])('%s → %s', (text, iso) => {
    expect(normalizeExitImportDate(text)).toBe(iso);
  });

  it.each([
    '2023/13/01',
    '2023/02/30',
    '2023-3-1',
    '2023.03.01',
    '20230301',
    '2023/3',
    '',
    '  ',
    '45000',
    '2023-03-01x',
  ])('无效或格式不在三种之内：%j → null', (text) => {
    expect(normalizeExitImportDate(text)).toBeNull();
  });
});

describe('F-493 原因码与错误文案（设计 §3.3，AC-DM-30-F493-32 纯函数部分）', () => {
  it('原因码集合 19 个，每个都有非空中文文案，页面上不出现英文原因码', () => {
    expect(EXIT_IMPORT_REASONS).toHaveLength(19);
    expect(new Set(EXIT_IMPORT_REASONS).size).toBe(19);
    for (const reason of EXIT_IMPORT_REASONS) {
      const column = reason === 'SUBMITTER_FORBIDDEN' || reason === 'SYSTEM_ERROR' ? null : 'D';
      const text = exitImportErrorText(column, reason, 'zzf496nope', 200);
      expect(text, reason).toMatch(/[一-龥]/);
      expect(text, reason).not.toContain(reason);
    }
  });

  it('第 2 版第 1 轮的 DEPARTMENT_DISABLED 不在集合里；新增 OPTION_NOT_FOUND、DEPARTMENT_NOT_FOUNDED', () => {
    expect(EXIT_IMPORT_REASONS).not.toContain('DEPARTMENT_DISABLED');
    expect(EXIT_IMPORT_REASONS).toEqual(expect.arrayContaining(['OPTION_NOT_FOUND', 'DEPARTMENT_NOT_FOUNDED']));
  });

  it('北森取证原文逐字：D 列不存在；N / P / Q 选项不存在；必填；b 类', () => {
    expect(exitImportErrorText('D', 'REFERENCE_NOT_FOUND', 'zzf496nope')).toBe(
      '[*部门编码]：*部门编码【zzf496nope】不存在或者已被删除，请检查',
    );
    expect(exitImportErrorText('N', 'OPTION_NOT_FOUND', 'M')).toBe('[性别]：性别【M】不存在或者已被删除，请检查');
    expect(exitImportErrorText('P', 'OPTION_NOT_FOUND', '汉')).toBe('[民族]：民族【汉】不存在或者已被删除，请检查');
    expect(exitImportErrorText('Q', 'OPTION_NOT_FOUND', '党员')).toBe(
      '[政治面貌]：政治面貌【党员】不存在或者已被删除，请检查',
    );
    expect(exitImportErrorText('B', 'REQUIRED', '')).toBe('[*姓名]：*姓名不能为空');
    expect(exitImportErrorText('C', 'LOGIN_TAKEN', 'syn.a@example.com')).toBe(
      '[*电子邮件]：当前邮箱已被使用，请更换邮箱',
    );
  });

  it('其余原因码按设计表格式拼接', () => {
    const c = 'syn.a@example.com';
    expect(exitImportErrorText('C', 'EMAIL_IN_EMPLOYEE', c)).toBe(
      `[*电子邮件]：*电子邮件【${c}】在员工信息中已存在，不允许导入`,
    );
    expect(exitImportErrorText('C', 'EMAIL_DUPLICATE_IN_FILE', c)).toBe(
      `[*电子邮件]：*电子邮件【${c}】在导入文件中重复出现，无法导入`,
    );
    expect(exitImportErrorText('C', 'INVALID_EMAIL', 'abc')).toBe('[*电子邮件]：*电子邮件【abc】格式不正确');
    expect(exitImportErrorText('B', 'TOO_LONG', '甲'.repeat(3), 200)).toBe(
      '[*姓名]：*姓名【甲甲甲】长度不能超过200个字符',
    );
    expect(exitImportErrorText('F', 'REFERENCE_AMBIGUOUS', '开发')).toBe(
      '[职位名称]：职位名称【开发】对应多条记录，请检查',
    );
    expect(exitImportErrorText('W', 'REFERENCE_DISABLED', '主动离职')).toBe(
      '[离职类型]：离职类型【主动离职】已停用，请检查',
    );
    expect(exitImportErrorText('K', 'INVALID_FORMAT', 'x')).toBe('[身份证号]：身份证号【x】格式不正确');
    expect(exitImportErrorText('Z', 'NOT_SUPPORTED', '说明')).toBe(
      '[离职说明]：离职说明【说明】暂不支持导入，请清空后再导入',
    );
    expect(exitImportErrorText('D', 'FIELD_HIDDEN', 'x')).toBe('[*部门编码]：无查看权限，错误原因已隐藏');
    expect(exitImportErrorText(null, 'SUBMITTER_FORBIDDEN')).toBe('提交人已无导入权限，本行未导入');
    expect(exitImportErrorText(null, 'SYSTEM_ERROR')).toBe('系统处理中断，本行未导入，请重新导入');
  });

  it('日期列的值取规整后的 yyyy/mm/dd，规整不了取原文', () => {
    expect(exitImportErrorText('E', 'DEPARTMENT_NOT_FOUNDED', '2019-1-1')).toBe(
      '[*入职日期]：*入职日期【2019-1-1】早于部门的设立日期，请检查',
    ); // 2019-1-1 不在三种格式内，取原文
    expect(exitImportErrorText('E', 'DEPARTMENT_NOT_FOUNDED', '2019/1/1')).toBe(
      '[*入职日期]：*入职日期【2019/01/01】早于部门的设立日期，请检查',
    );
    expect(exitImportErrorText('V', 'NOT_HISTORICAL', '2026-12-01')).toBe(
      '[*最后工作日]：*最后工作日【2026/12/01】必须早于今天，今天及以后的离职请走离职流程',
    );
    expect(exitImportErrorText('V', 'RANGE_INVERTED', '2020/01/01')).toBe(
      '[*最后工作日]：*最后工作日【2020/01/01】不能早于入职日期',
    );
    expect(exitImportErrorText('E', 'INVALID_DATE', '2023/13/01')).toBe(
      '[*入职日期]：*入职日期【2023/13/01】不是有效日期，请按yyyy/mm/dd填写',
    );
  });

  it('带列原因码给了未知列、没给列时报错（编程错误不静默出空文案）', () => {
    expect(() => exitImportErrorText('AA', 'REQUIRED', '')).toThrow();
    expect(() => exitImportErrorText(null, 'REQUIRED', '')).toThrow();
    expect(() => exitImportErrorText('B', 'NO_SUCH_REASON', '')).toThrow();
  });
});

describe('F-493 同文件电子邮件重复 duplicateEmailRows（c 类，AC-DM-30-F493-06 纯函数部分）', () => {
  it('只差大小写和首尾空格的两行都命中，另一行不命中', () => {
    const rows = [
      { rowNo: 2, email: 'Syn.A@Example.com' },
      { rowNo: 3, email: 'syn.b@example.com' },
      { rowNo: 5, email: '  syn.a@example.com ' },
    ];
    expect([...duplicateEmailRows(rows)].sort()).toEqual([2, 5]);
  });

  it('三行同邮箱全部命中；C 为空 / 全空白的行不参与', () => {
    const rows = [
      { rowNo: 2, email: 'x@example.com' },
      { rowNo: 3, email: 'X@example.com' },
      { rowNo: 4, email: 'x@EXAMPLE.com' },
      { rowNo: 5, email: null },
      { rowNo: 6, email: null },
      { rowNo: 7, email: '   ' },
      { rowNo: 8, email: '' },
    ];
    expect([...duplicateEmailRows(rows)].sort()).toEqual([2, 3, 4]);
  });
});
