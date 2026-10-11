"""用 Python 标准库独立校验 ZIP CRC 和所有 XML，再读取实际工作表；不复用生产转义器。"""
import io
import json
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None, "ZIP CRC 校验失败"
    parts = {
        name: ET.fromstring(archive.read(name))
        for name in archive.namelist()
        if name.endswith((".xml", ".rels"))
    }
    sheets = parts["xl/workbook.xml"].find(NS + "sheets")
    assert len(sheets) == 1, "每份图谱只能有一张工作表"
    targets = {
        link.get("Id"): link.get("Target")
        for link in parts["xl/_rels/workbook.xml.rels"]
    }
    target = targets[sheets[0].get(REL + "id")]
    sheet_path = posixpath.normpath(posixpath.join("xl", target))
    rows = []
    for row in parts[sheet_path].find(NS + "sheetData"):
        cells = []
        for cell in row:
            assert cell.get("t") == "inlineStr", "图谱值应为文本"
            assert cell.find(NS + "f") is None, "图谱不能包含公式"
            cells.append("".join(cell.find(NS + "is").itertext()))
        rows.append(cells)
    json.dump({"sheetNames": [sheet.get("name") for sheet in sheets], "rows": rows}, sys.stdout)
