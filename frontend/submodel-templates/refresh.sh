#!/usr/bin/env bash
# Re-downloads everything in this folder from its upstream sources.
#
#   ./refresh.sh          refresh everything
#   ./refresh.sh --index  only rebuild inventory.json from the files already here
#
# Nothing here is hand-edited, so this script is the folder: if a download looks wrong,
# delete the folder and run it again. Requires bash, curl, tar and python3.
set -euo pipefail
cd "$(dirname "$0")"

SMT_REPO=https://codeload.github.com/admin-shell-io/submodel-templates/tar.gz/refs/heads/main
MM_REPO=https://codeload.github.com/admin-shell-io/aas-specs-metamodel/tar.gz/refs/heads/master
SPEC_PAGE=https://industrialdigitaltwin.org/en/content-hub/aasspecifications
SMT_PAGE=https://industrialdigitaltwin.org/en/content-hub/submodels
UA="Mozilla/5.0 (compatible; kaigara-refresh)"

build_index() {
  python3 index.py
}

if [[ "${1:-}" == "--index" ]]; then build_index; exit 0; fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "→ submodel templates  (github.com/admin-shell-io/submodel-templates)"
curl -fsSL -o "$tmp/smt.tar.gz" "$SMT_REPO"
mkdir -p "$tmp/smt" && tar xzf "$tmp/smt.tar.gz" -C "$tmp/smt" --strip-components=1
rm -rf submodels/published && mkdir -p submodels
cp -R "$tmp/smt/published" submodels/published
cp "$tmp/smt/README.md" submodels/GITHUB-README.md
cp "$tmp/smt/LICENSE.txt" submodels/LICENSE.txt

echo "→ metamodel           (github.com/admin-shell-io/aas-specs-metamodel)"
curl -fsSL -o "$tmp/mm.tar.gz" "$MM_REPO"
mkdir -p "$tmp/mm" && tar xzf "$tmp/mm.tar.gz" -C "$tmp/mm" --strip-components=1
rm -rf metamodel/schemas metamodel/documentation && mkdir -p metamodel
cp -R "$tmp/mm/schemas" metamodel/schemas
cp -R "$tmp/mm/documentation" metamodel/documentation
cp "$tmp/mm/README.md" metamodel/GITHUB-README.md
cp "$tmp/mm/LICENSE.txt" metamodel/LICENSE.txt
rm -f metamodel/schemas/*.ps1

echo "→ specification PDFs  (industrialdigitaltwin.org, IDTA-01001…01005)"
mkdir -p metamodel/specifications
curl -fsSL -A "$UA" "$SPEC_PAGE" -o "$tmp/specs.html"
grep -oE 'href="[^"]*specification-of-the-asset-administration-shell[^"]*"' "$tmp/specs.html" \
  | sed 's/href="//; s/"$//' | sort -u > "$tmp/part-pages.txt"
: > "$tmp/spec-pdfs.txt"
while read -r page; do
  curl -fsSL -A "$UA" "$page" | grep -oE 'https://[^"'"'"' ]*\.pdf' >> "$tmp/spec-pdfs.txt" || true
done < "$tmp/part-pages.txt"
sort -u "$tmp/spec-pdfs.txt" -o "$tmp/spec-pdfs.txt"
while read -r u; do
  [[ -z "$u" ]] && continue
  echo "   $(basename "$u")"
  curl -fsSL -A "$UA" -o "metamodel/specifications/$(basename "$u")" "$u"
done < "$tmp/spec-pdfs.txt"

echo "→ website-only submodel PDFs (anything the GitHub repo does not carry)"
mkdir -p submodels/idta-website
curl -fsSL -A "$UA" "$SMT_PAGE" -o "$tmp/smt-page.html"
grep -oE 'https://[^"'"'"' ]*\.pdf' "$tmp/smt-page.html" | sort -u > "$tmp/site-pdfs.txt"
python3 - "$tmp/site-pdfs.txt" "$tmp/missing.txt" <<'PY'
import re, sys, pathlib, urllib.parse
def key(name):
    s = re.sub(r'-+', '-', re.sub(r'[\s_]+', '-', urllib.parse.unquote(name).lower()))
    m = re.search(r'idta-?(\d{4,5})(-?[ab])?((?:-\d+)*)', s)
    return (m.group(1).zfill(5), (m.group(2) or '').strip('-'),
            tuple(int(x) for x in m.group(3).split('-') if x)) if m else None
have = {key(p.name) for p in pathlib.Path("submodels/published").rglob("*.pdf")}
urls = pathlib.Path(sys.argv[1]).read_text().split()
missing = [u for u in urls if key(u.rsplit('/', 1)[-1]) not in have]
pathlib.Path(sys.argv[2]).write_text("\n".join(missing) + ("\n" if missing else ""))
print(f"   {len(urls)} on the website, {len(urls) - len(missing)} already in published/, {len(missing)} to fetch")
PY
while read -r u; do
  [[ -z "$u" ]] && continue
  echo "   $(basename "$u")"
  curl -fsSL -A "$UA" -o "submodels/idta-website/$(basename "$u")" "$u"
done < "$tmp/missing.txt"

find . -name ".DS_Store" -delete

echo "→ index"
build_index
echo "done."
