# R1 P3新窗口取件与启动

生成来源：`Scope_Register.json → deliveryScope / p1Baseline / modules[].p1 / p1B`。本文是同一台账的阅读视图，不独立维护范围或验收状态。更新时间：2026-09-10T03:24:03.609414+00:00。

当前交付为用户确认的15个HR核心模块及六类非模块基础能力；原48组历史完整保留，33组本次交付暂缓，不计完成、不阻当前P1退出。各历史证据的适用时间保持。

所有者已批准R1 P2退出并明确准入P3；实际P3尚未开始。

请作为独立R1 P3窗口，先只读核main实际HEAD、Scope中的R1 P2纳入记录与R1-P3-ENTRY-OWNER-20260910。不得改main事实源或进入P2工作树。通过以下Git对象读取原完整启动词，校验SHA256后按其完整边界执行；本文件仅提供总控授权及取件索引，不复制设计事实。

```bash
git show e15237281ff19f04f08a354fd9455c518b24ae47:docs/delivery/r1-p2/R1_P2_P3_Start_Prompt.md
```

SHA256：`eb06c0b47931fab637a4c5c19c1670fbe56560ff77166704986bfaa7bf2cca10`。同时读取下列固定对象：

| 分支 | 固定提交 | 路径 | SHA256 |
|---|---|---|---|
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_Controller_Proposal.json | a8d1873c712601d90e1ad498feb202343e6f8d12d7405185052db7596dd904da |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_Exit_Review.md | 53ee09fe93fcf667afe48c6cf3b21cada18645a9950f0f1cb18e06faa02cb149 |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_P3_Handoff.md | 2df90ce6d557500f65206cf458d7b548d94fd8a9205bbc0c977f4a83c9273c14 |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_P3_Start_Prompt.md | eb06c0b47931fab637a4c5c19c1670fbe56560ff77166704986bfaa7bf2cca10 |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_Owner_Exit_Approval.json | 2905b1cfeb18ead0985a49fbaadc55d13b39bba354599a92a15352499e04cda0 |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_Limit_Resolution.json | f4400e6ef0d37493637468b7862e29ebcc2c75c3fdb2b7eda1b4d09011232cda |
| design/r1-p2-20260909 | e15237281ff19f04f08a354fd9455c518b24ae47 | docs/delivery/r1-p2/R1_P2_Dependencies_Decisions.json | 8b536d2f10e0ef4db8ac583b4e63d7a9643846a1764b6466f21ad6543a902e93 |

按原启动词创建独立P3工作树，复用最新main，保护已有修改；单主任务，隔离合成测试，不新增访问者、不部署、不做生产迁移/真实外发。P2记录本身未授权P3执行，本次总控R1-P3-ENTRY-OWNER-20260910提供进入授权；P4和生产须另行评审。
