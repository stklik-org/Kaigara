#!/usr/bin/env python3
"""Builds inventory.json — one record per template file under submodels/published/.

Everything else in this folder is upstream material copied verbatim; this is the only
derived artefact, and it exists so the app (and a human) can answer "which templates do we
have, what is each one's semanticId, and how big is it?" without opening 161 JSON files.
Run through ./refresh.sh, or directly: python3 index.py
"""
import collections
import datetime
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
PUBLISHED = ROOT / "submodels" / "published"


def count_elements(elements) -> int:
    """SubmodelElements, counted recursively — collections and lists nest arbitrarily."""
    total = 0
    for element in elements or []:
        total += 1
        for key in ("value", "statements", "annotations"):
            nested = element.get(key)
            if isinstance(nested, list):
                total += count_elements(nested)
    return total


def semantic_id(obj):
    reference = obj.get("semanticId")
    if isinstance(reference, dict):
        keys = reference.get("keys") or []
        if keys and isinstance(keys[0], dict):
            return keys[0].get("value")
    return None


def idta_number(filename: str):
    """"IDTA 02006-3-0-1_Template_….json" -> ("02006", "3.0.1")."""
    match = re.search(r"IDTA[ _-]?(\d{4,5})((?:-\d+)*)", filename)
    if not match:
        return None, None
    return match.group(1).zfill(5), match.group(2).lstrip("-").replace("-", ".") or None


def main() -> None:
    entries, problems = [], []
    for path in sorted(PUBLISHED.rglob("*.json")):
        parts = path.relative_to(PUBLISHED).parts
        try:
            # utf-8-sig: several upstream files carry a BOM.
            document = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            problems.append((path.as_posix(), f"{type(exc).__name__}: {exc}"))
            continue

        if isinstance(document, dict) and "submodels" in document:
            submodels = document.get("submodels") or []
        elif isinstance(document, dict) and document.get("modelType") == "Submodel":
            submodels = [document]
        else:
            submodels = []

        number, version = idta_number(path.name)
        entries.append({
            "family": parts[0],
            "versionPath": "/".join(parts[1:-1]),
            "idtaNumber": number,
            "idtaVersion": version,
            "file": path.relative_to(ROOT).as_posix(),
            "bytes": path.stat().st_size,
            "hasAasx": bool(list(path.parent.glob("*.aasx"))),
            "hasPdf": bool(list(path.parent.glob("*.pdf"))),
            "shells": len(document.get("assetAdministrationShells") or []),
            "conceptDescriptions": len(document.get("conceptDescriptions") or []),
            "submodels": [{
                "idShort": sm.get("idShort"),
                "id": sm.get("id"),
                "semanticId": semantic_id(sm),
                "kind": sm.get("kind"),
                "elementCount": count_elements(sm.get("submodelElements")),
            } for sm in submodels if isinstance(sm, dict)],
        })

    families = collections.Counter(entry["family"] for entry in entries)
    inventory = {
        "generated": datetime.date.today().isoformat(),
        "sources": {
            "submodelTemplates": "https://github.com/admin-shell-io/submodel-templates (main)",
            "metamodel": "https://github.com/admin-shell-io/aas-specs-metamodel (master)",
            "specifications": "https://industrialdigitaltwin.org/en/content-hub/aasspecifications",
            "license": "CC-BY-4.0",
        },
        "counts": {
            "families": len(families),
            "templateFiles": len(entries),
            "submodels": sum(len(entry["submodels"]) for entry in entries),
            "unparseable": len(problems),
        },
        "templates": entries,
    }
    (ROOT / "inventory.json").write_text(json.dumps(inventory, indent=1, ensure_ascii=False) + "\n")

    print(f"   {len(families)} families, {len(entries)} template files, "
          f"{inventory['counts']['submodels']} submodels indexed")
    for path, error in problems:
        print(f"   ! unparseable: {path} — {error}")


if __name__ == "__main__":
    main()
