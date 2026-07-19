#!/usr/bin/env python3
"""Fail when a Risk Matrix row is not mapped to an executable audit rule."""

import json
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
WORKBOOK = ROOT / "RGHS_Healthcare_Coding_Risk_Audit_Matrix.xlsx"
COVERAGE = Path(__file__).resolve().parent / "matrix-coverage.json"
CURATION = Path(__file__).resolve().parent / "rule-curation.json"
BUILT_INS = {"DUP-CODE", "AMT-CALC", "MM-DUP", "MULTI-MAJOR"}


def main():
    coverage = json.loads(COVERAGE.read_text(encoding="utf-8"))
    curation = json.loads(CURATION.read_text(encoding="utf-8"))
    rule_ids = set(BUILT_INS)
    for collection in ("bundles", "mutuallyExclusive", "addOnDependencies", "combinedAvailable", "adjunctClusters", "reviewTriggers"):
        rule_ids.update(rule["ruleId"] for rule in curation[collection])

    sheet = openpyxl.load_workbook(WORKBOOK, data_only=True, read_only=True)["Risk Matrix"]
    matrix_rows = {row: str(sheet.cell(row, 3).value or "").strip() for row in range(5, 52)}
    mapped_rows = {item["row"] for item in coverage}
    errors = []
    if mapped_rows != set(matrix_rows):
        errors.append(f"row coverage mismatch: missing={sorted(set(matrix_rows) - mapped_rows)} extra={sorted(mapped_rows - set(matrix_rows))}")
    for item in coverage:
        actual = matrix_rows.get(item["row"], "")
        if actual != item["primary"]:
            errors.append(f"row {item['row']} title changed: expected {item['primary']!r}, got {actual!r}")
        unknown = sorted(set(item["rules"]) - rule_ids)
        if unknown:
            errors.append(f"row {item['row']} references unknown rules: {unknown}")
        if not item["rules"]:
            errors.append(f"row {item['row']} has no executable rule")
    if errors:
        raise SystemExit("Matrix coverage validation failed:\n- " + "\n- ".join(errors))
    print(f"Validated {len(coverage)} Risk Matrix rows against {len(rule_ids)} executable rule IDs")


if __name__ == "__main__":
    main()
