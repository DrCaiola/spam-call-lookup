"""Convert NANPA's utilized central-office code assignments into per-NPA JSON shards.

Source: https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip
(public data, updated daily). Tab-delimited: State, NPA-NXX, OCN, Company, RateCenter, ...

Output: data/nxx/<npa>.json -> { "nxx": ["RATECENTER", "COMPANY"], ... }
The app fetches only the shard for the area code being looked up.

Refresh:
  curl -sL https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip -o data/cocodes_raw.zip
  python data/convert_nxx.py
"""
import io
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "cocodes_raw.zip"
OUT_DIR = HERE / "nxx"


def main() -> None:
    z = zipfile.ZipFile(SRC)
    raw = z.open(z.namelist()[0])
    text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")

    header = text.readline().rstrip("\r\n").split("\t")
    cols = {name.strip(): i for i, name in enumerate(header)}
    i_npanxx = cols["NPA-NXX"]
    i_company = cols["Company"]
    i_rc = cols["RateCenter"]

    shards: dict[str, dict[str, list[str]]] = {}
    rows = 0
    for line in text:
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) <= max(i_npanxx, i_company, i_rc):
            continue
        npanxx = parts[i_npanxx].strip()
        if len(npanxx) != 7 or npanxx[3] != "-":
            continue
        npa, nxx = npanxx[:3], npanxx[4:]
        company = parts[i_company].strip().strip('"').strip()
        rc = parts[i_rc].strip()
        shards.setdefault(npa, {})[nxx] = [rc, company]
        rows += 1

    OUT_DIR.mkdir(exist_ok=True)
    for old in OUT_DIR.glob("*.json"):
        old.unlink()
    for npa, codes in shards.items():
        (OUT_DIR / f"{npa}.json").write_text(
            json.dumps(codes, separators=(",", ":")), encoding="utf-8"
        )
    print(f"Wrote {rows} NPA-NXX assignments into {len(shards)} shards -> {OUT_DIR}")


if __name__ == "__main__":
    sys.exit(main())
