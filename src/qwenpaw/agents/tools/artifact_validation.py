# -*- coding: utf-8 -*-
"""Validate supported generated artifacts before publishing download links."""
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree


def validate_artifact(path: Path) -> None:
    if path.stat().st_size == 0:
        raise ValueError("artifact_empty")
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader

        with path.open("rb") as stream:
            reader = PdfReader(stream)
            if reader.is_encrypted or not reader.pages:
                raise ValueError("artifact_pdf_unreadable")
            for page in reader.pages:
                page.get_contents()
    elif suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}:
        from PIL import Image

        with Image.open(path) as image:
            image.verify()
    elif suffix in {".docx", ".pptx", ".xlsx"}:
        main = {
            ".docx": "word/document.xml",
            ".pptx": "ppt/presentation.xml",
            ".xlsx": "xl/workbook.xml",
        }[suffix]
        with ZipFile(path) as archive:
            ElementTree.fromstring(archive.read("[Content_Types].xml"))
            ElementTree.fromstring(archive.read(main))
