# 内置中文字体（F-080，DEC-375①）

报告 PDF / 报表 PNG 的栅格化只用本目录里的字体，不依赖服务器安装的字体。

| 文件 | 内容 |
|---|---|
| `NotoSansSC-Regular.subset.ttf` / `NotoSansSC-Bold.subset.ttf` | Noto Sans SC（思源黑体）Regular（400）与 Bold（700）的常用字子集，各约 2.2 MB |
| `OFL.txt` | 字体许可：SIL Open Font License 1.1（Copyright 2014-2021 Adobe，保留字体名 “Source”） |

- **来源**：npm 包 `@expo-google-fonts/noto-sans-sc@0.4.4` 里的静态字体（Google Fonts 分发的 Noto Sans SC，上游为 Adobe / Google 的思源黑体 2.004）。
- **字表**：GB 2312-80 全部字符（6763 个常用汉字 + 682 个符号 / 全角标点 / 假名 / 拼音 / 希腊与西里尔字母）+ ASCII 可打印字符 + 常用空白与通用标点，共 7557 个字符。字表取自 Python 内置的 gb2312 编码表，没有外部下载。生僻字（如部分人名用字）不在字表内，渲染时缺字形；需要时换用完整字体重新子集化。
- **可复现**：`scripts/fonts/build-cjk-subset.py`（先核对输入字体的 SHA-256，再用固定版本的 fonttools 子集化，不重算时间戳，同一输入输出字节相同）。
- **许可要点**：OFL 允许随软件打包、再分发与修改，子集化属于修改；修改版不得使用保留字体名 “Source”，本子集的字体名为 “Noto Sans SC”，不含 “Source”。字体不单独出售。
- **完整性**：`apps/api/src/modules/survey360/export-fonts.ts` 登记了两个字体文件的 SHA-256，进程启动时校验，缺失或被改动即拒绝启动。重新子集化后须同步更新登记值。
- 这些文件不进 F-039 的证据闭包与摘要（闭包只认 TypeScript 源码单元）。
