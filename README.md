# Day Trading & TrendSpider Bible — v1.0

Personal training manual, operating runbook and reference guide for the **RB Day Trading System v1**
(TrendSpider → SignalStack → Alpaca Paper). Created 2026-10-28.

## Read it

| File | Use |
|---|---|
| `dist/Day-Trading-TrendSpider-Bible-v1.0.pdf` | Print / tablet (116 pages) |
| `dist/Day-Trading-TrendSpider-Bible-v1.0.docx` | Microsoft Word (editable) |
| `dist/Day-Trading-TrendSpider-Bible-v1.0.html` | Single-file desktop/tablet reading (light/dark) |
| `journal/RB-v1-Trade-Journal.xlsx` | Trade journal, position sizer and performance stats |

## Edit it

The source of truth is `manual/*.md` (Pandoc Markdown). Don't edit the files in `dist/`; rebuild them instead.

```bash
python tools/make_figures.py   # schematic diagrams -> manual/figures
python tools/make_journal.py   # journal workbook
python tools/build.py          # docx + html + pdf (uses Word for TOC/PDF if installed)
```

Requires `pip install pypandoc_binary python-docx matplotlib openpyxl`.

## Screenshots

No product screenshots are included yet. Every `[SCREENSHOT REQUIRED — SS-xx]` box is listed in
Appendix C. Save captures as `manual/screenshots/SS-xx.png`, replace the box with
`![caption](screenshots/SS-xx.png)`, and rebuild.

## Changing the strategy

Never edit v1 rules silently. Add a row to the Change Log (Appendix E in `manual/09-appendices.md`),
bump the version, and rebuild.
