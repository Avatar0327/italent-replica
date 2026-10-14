#!/usr/bin/env python3
"""生成内置中文字体子集（F-080，DEC-375①）。

输入：npm 包 @expo-google-fonts/noto-sans-sc@0.4.4 里的 Noto Sans SC 静态字体（Google Fonts 分发的 Noto Sans SC，
上游为 Adobe / Google 的思源黑体 2.004，SIL OFL 1.1），Regular（400）与 Bold（700）两个字重。
字表：GB 2312-80 全部双字节字符（Python 内置 gb2312 编码表：6763 个常用汉字 + 682 个符号 / 全角标点 / 假名 / 拼音 /
希腊与西里尔字母）+ ASCII 可打印字符 + 常用空白与通用标点。字表来自 Python 标准库编码表，没有外部下载，可复现。
生僻字（如部分人名用字）不在字表内，渲染时会缺字形；完整字体作为备选（DEC-375①）。

用法（输入输出目录都要事先存在，不要在输入目录里运行）：
    npm pack @expo-google-fonts/noto-sans-sc@0.4.4          # 在一个空目录里，再解出两个 ttf
    pip install fonttools==4.66.1
    python3 scripts/fonts/build-cjk-subset.py <输入目录> apps/api/assets/fonts

输入目录须含 NotoSansSC_400Regular.ttf 与 NotoSansSC_700Bold.ttf，脚本先核对 SHA-256（不一致即退出），输出
NotoSansSC-Regular.subset.ttf、NotoSansSC-Bold.subset.ttf；同一输入与同一 fonttools 版本输出字节相同（不重算时间戳）。
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

INPUTS = {
    "NotoSansSC_400Regular.ttf": ("d45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16", "NotoSansSC-Regular.subset.ttf"),
    "NotoSansSC_700Bold.ttf": ("9a38ae0ab28cd5a256f9ea8e00dedc688aac17f7915fcb000572990afa956b96", "NotoSansSC-Bold.subset.ttf"),
}


def charset() -> set[int]:
    chars: set[int] = set(range(0x20, 0x7F))
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                chars.add(ord(bytes([high, low]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    # 不间断空格、间隔号、通用标点（引号、破折号、省略号等）
    chars |= {0x00A0, 0x00B7, *range(0x2010, 0x2028), 0x2030, 0x2032, 0x2033, 0x203B, 0x20AC}
    return chars


def main(source: Path, target: Path) -> None:
    unicodes = charset()
    target.mkdir(parents=True, exist_ok=True)
    for name, (digest, output) in INPUTS.items():
        data = (source / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            sys.exit(f"{name} 的 SHA-256 与登记值不一致，输入字体版本不对")
        options = subset.Options()
        options.layout_features = []  # 不带 GSUB / GPOS 特性：版面只做逐字排列
        options.hinting = False
        options.notdef_outline = True
        options.name_IDs = list(range(0, 15))
        options.recalc_timestamp = False
        options.drop_tables += ["vhea", "vmtx", "BASE", "STAT", "gasp"]
        font = TTFont(source / name, recalcTimestamp=False)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        font.save(target / output)
        print(f"{output}: {(target / output).stat().st_size} 字节, {len(font.getBestCmap())} 个字符")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
