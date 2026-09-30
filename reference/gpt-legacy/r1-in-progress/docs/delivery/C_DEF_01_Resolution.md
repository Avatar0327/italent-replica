# C-DEF-01 修复记录

干部交付420edae82648bb0a103e169843be2d66dc737f7b已核对并快进合入main。8个文件为H002许可的测试和文档；原6/6结果包含400现状断言，不是缺陷关闭证据。

根因：validateGrant不区分启用与停用，始终要求关联档案在职。修复仅令active=false可关联当前租户中已离职的既有员工；active=true继续要求在职，不存在员工继续拒绝。未修改自动离职停用政策，不清除员工关联，不直接写数据库，不改变原CAS及审计事务。

回归：tests/g1-cadre-exit.test.mjs已改成实际停用200、active=0、员工关联保留、修订+1及审计存在、停用后本人hris/development/profile/history读取403。补旧修订409、离职关联重新启用400、缺失员工400、管理员自停用400。HR停用和其他原断言保留。

本轮完整命令：node --test tests/hris.test.mjs tests/authorization.test.mjs tests/workflows.test.mjs tests/p2-api.test.mjs tests/p3-api.test.mjs tests/g0-contracts.test.mjs tests/g1-foundation.test.mjs tests/g1-cadre-exit.test.mjs
结果：115/115通过，0失败/跳过，18595.846187ms。本地合成SQLite/身份/R2，不代表真实多账号或生产验收。原干部交付与测试记录保留历史，以本修复记录覆盖C-DEF-01未修复状态。G1仍需学习组合与人工验收。

类型检查及构建通过，修复已于v67私有发布成功，应用SHA cb939378959a0f4d9a872890708e5b3b724b7234。发布不代表企业生产验收完成。
