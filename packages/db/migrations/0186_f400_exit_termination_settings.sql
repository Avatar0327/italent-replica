-- F-400（DEC-725）：离职生效时终止在途流程，按流程类型逐类勾选（规格 30 SwitchTypes=41）。
-- 两层配置的系统值即本租户预置：28 类勾选 27 类，只有“新建合同协议”不勾；租户覆盖走既有 /api/tenant/settings/:key。
-- 键与 packages/domain/src/employment/exit-termination.ts 的 EXIT_TERMINATION_FLOWS 一致（由验收测试核对）。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('exit.termination_flow_types', jsonb_build_object(
  'regularization', true, 'transfer', true, 'inter_org_transfer', true, 'batch_transfer', true,
  'labor_regularization', true, 'intern_regularization', true, 'part_time_add', true, 'part_time_extend', true,
  'part_time_end', true, 'contract_create', false, 'contract_renew', true, 'contract_change', true,
  'contract_terminate', true, 'probation_assessment', true, 'regularization_assessment', true, 'emp_info_change', true,
  'onboarding_info_collect', true, 'education', true, 'family', true, 'jobhistory', true,
  'training', true, 'project-experience', true, 'awards', true, 'language-ability', true,
  'skill', true, 'punish', true, 'certificate', true, 'retirement_intention', true
  ), '离职 / 退休：生效时终止在途流程（按流程类型勾选；未勾选的任职 / 合同流程按最后工作日规则）', true, 1, now());
