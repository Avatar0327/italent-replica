// 规格 30 SwitchTypes=41；流程名称直接取 domain 目录（DEC-045）。
export const terminationMessages = {
  title: '离职/退休生效时终止在途流程',
  groups: { employment: '任职流程', contract: '合同流程', assessment: '考核流程', personal: '个人信息流程' },
  hints: {
    employment: '不勾选时，只终止最后工作日之后的在途任职流程。',
    contract: '不勾选时，只终止终止日期在最后工作日之后的在途合同流程。',
    assessment: '勾选后，离职生效时终止所选考核流程。',
    personal: '勾选后，离职生效时终止所选个人信息流程。',
  },
  fixed: '新增兼职固定终止，不可取消。',
  invalidRead: '终止在途流程配置读取结果无效，请刷新后重试',
  invalidReceipt: '保存回执无效，请回查原配置',
  saved: '终止在途流程配置已保存',
};
