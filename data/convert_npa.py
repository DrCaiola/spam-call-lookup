"""Convert the official NANPA npa_report.csv into a compact JSON map used by the app.

Source: https://reports.nanpa.com/public/npa_report.csv (public data).
Output: data/areacodes.json  ->  { "203": {"loc": "CT", "country": "US", "tz": "E"}, ... }

Re-run this script to refresh the bundled data:  python data/convert_npa.py
"""
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "npa_report_raw.csv"
OUT = HERE / "areacodes.json"


def main() -> None:
    with SRC.open(newline="", encoding="utf-8-sig") as f:
        first = f.readline()  # "File Date,MM/DD/YYYY"
        file_date = first.split(",", 1)[1].strip() if "," in first else ""
        reader = csv.DictReader(f)
        codes = {}
        for row in reader:
            npa = (row.get("NPA_ID") or "").strip()
            if not npa.isdigit() or len(npa) != 3:
                continue
            if (row.get("ASSIGNED") or "").strip().lower() != "yes":
                continue
            entry = {}
            loc = (row.get("LOCATION") or "").strip()
            country = (row.get("COUNTRY") or "").strip()
            service = (row.get("SERVICE") or "").strip()
            tz = (row.get("TIME_ZONE") or "").strip()
            use = (row.get("USE") or "").strip()
            if loc:
                entry["loc"] = loc
            if country:
                entry["country"] = country
            if tz:
                entry["tz"] = tz
            if use and use.upper() not in ("G", "GEOGRAPHIC"):
                entry["use"] = use
            if service:
                entry["service"] = service
            codes[npa] = entry

    OUT.write_text(
        json.dumps({"file_date": file_date, "codes": codes}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {len(codes)} area codes (source dated {file_date}) -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
