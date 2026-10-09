---
name: dev-selfcheck
description: 所有开发任务必做（DEC-338）：开发方在 PR 上贴“开发完成，待审”之前跑的自检：用 open-code-review 的项目规则逐文件检查本次改动，再对照设计与 DEC 核一遍，把结果写进“开发完成”评论。B / C 档都适用。
---

# 开发自检（所有开发任务必做，DEC-338）

目的：把审查里反复出现的 P2（权限与范围外泄露、数据正确性、并发幂等、行为兼容）在交审前消掉，减少审查轮数。自检不替代正式审查。

## 步骤

1. **先同步 main**：`git fetch && git merge origin/main`；有迁移的按 DEC-221 用 `db:generate` 重新生成。
2. **列出要审的文件**（规则在仓库 `.opencodereview/rule.json`）：
   ```bash
   ocr delegate preview --from origin/main --to HEAD
   ```
   `ocr` 不在 PATH 时用 `~/.npm-global/bin/ocr`；本机未安装就先安装（`npm install -g --allow-scripts=@alibaba-group/open-code-review @alibaba-group/open-code-review`）。装不上时在“开发完成”评论里写明原因，并报告总编排（DEC-338③，不得跳过）。
3. **按规则逐组审**：
   ```bash
   ocr delegate rule <上一步列出的文件…>
   ```
   **按目录分批传文件**（apps/api、apps/web、packages、tests 各跑一次）：一次传入全部文件时，OCR 有时只输出第 1 组规则。输出按规则分组。改动超过约 3,000 行业务代码时，按区域拆给多个子代理并行审，单个子代理审不完。对每一组，开一个子代理（High 档，不用 Max），给它：该组文件的 diff、该组规则原文、本 PR 对应的设计章节和 DEC 编号。要求它只报“当前改动里会真实触发”的问题，每条写文件:行、触发场景、建议修法。
4. **对照设计与 DEC**：逐条核对 PR 描述里的验收点 / 修改清单是否都有实现和测试；凡是没有取证或 DEC 依据的业务规则，列出来，不要自行推断（DEC-285②）。
5. **修掉发现的问题**：先补能复现的失败测试，再修；修完重跑第 2～3 步，只看改动过的文件。
6. **写进“开发完成”评论**，格式：
   ```
   开发完成，待审（第 N 轮，head <sha>，CI 绿）
   自检：OCR 规则 <n> 组 / 子代理发现 <x> 项，已修 <y> 项，未修 <z> 项（理由）
   ```

## 不要做的事
- 不要因为自检没发现问题就跳过正式审查，或降低审查档位。
- 不要为了让自检通过去改 `.opencodereview/rule.json`；规则有误请在 PR 里提出，由进度窗口统一改。
- 不要配置 OCR 的模型 API key、不要开启遥测；只用委托模式（delegate）。
