# 📵 Who Called? — Free Spam Call Lookup

**Live tool: https://drcaiola.github.io/spam-call-lookup/**

Check any US/Canada phone number against **real federal complaint records** to see
whether it's a likely spam caller. No paywall, no sign-up, no ads, no tracking.

Commercial "reverse lookup" sites charge for this because true caller-name (CNAM)
data is carrier-owned and licensed — but the data that actually answers *"is this
spam?"* is public:

- **[FCC Consumer Complaints Data](https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/vakf-fz8e)** —
  every unwanted-call complaint filed with the FCC, including the caller ID number
  reported, call type (robocall, prerecorded voice, text…), date, and state.
- **[NANPA area code registry](https://reports.nanpa.com/)** — the official North
  American Numbering Plan data, used for area-code region / time zone / toll-free
  identification (bundled as a compact JSON).

## How it works

The whole thing is a static page. When you look up a number, your browser queries
the FCC's public Socrata API directly (`opendata.fcc.gov`) for complaints matching
that caller ID, then renders:

- a **verdict** (no complaints / a few / likely spam / very likely spam) based on
  complaint volume and recency,
- a **complaint summary** (total, most recent, most common call type, states),
- a **complaints-by-year chart** and the most recent individual reports,
- **area code info** from the bundled NANPA data,
- one-click links to Google the number or report it to the FCC/FTC.

The number you type is sent to exactly one place: the FCC's public API.

## Run locally

No build step, no dependencies:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

## Refresh the bundled area-code data

```sh
curl -sL https://reports.nanpa.com/public/npa_report.csv -o data/npa_report_raw.csv
python data/convert_npa.py
```

## Caveats

- **No complaints ≠ safe.** Spammers rotate and spoof caller IDs constantly.
- **Complaints ≠ guilty.** A heavily-reported number may itself be spoofed and
  belong to an innocent party.
- Complaint data reflects what consumers filed with the FCC; it lags reality and
  is not a caller-identity database.
- Not affiliated with the FCC, FTC, or NANPA.

## License

[MIT](LICENSE)
