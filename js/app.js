/* Who Called? — free spam-call lookup against public FCC complaint records.
 * Everything runs client-side. The only network calls are to the FCC's public
 * Socrata API (opendata.fcc.gov) and this site's own bundled area-code data.
 */
(() => {
  "use strict";

  const FCC_API = "https://opendata.fcc.gov/resource/vakf-fz8e.json";
  const MAX_DETAIL_ROWS = 1000;
  const RECENT_ROWS_SHOWN = 10;

  const $ = (id) => document.getElementById(id);
  const form = $("lookup-form");
  const input = $("phone-input");
  const btn = $("lookup-btn");
  const errorEl = $("input-error");
  const results = $("results");
  const loading = $("loading");

  let areaCodes = null; // lazy-loaded { file_date, codes: { "203": {...} } }
  const nxxCache = {}; // per-area-code prefix shards: { "719": { "452": [rateCenter, carrier] } }

  // Wholesale/VoIP carriers whose numbers are disproportionately used for robocalls.
  const VOIP_CARRIERS = /onvoy|inteliquent|sinch|bandwidth\.com|bandwidth inc|twilio|telnyx|peerless|level 3|centurylink communications|lumen|vonage|magicjack|ymax|voip|commio|thinq|teleport|track(?:fone)? wireless/i;

  // NPR-style tile grid map: state -> [col, row]
  const STATE_TILES = {
    AK: [0, 0], ME: [11, 0],
    VT: [10, 1], NH: [11, 1],
    WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
    OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
    CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
    AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
    OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
    HI: [0, 7], TX: [4, 7], FL: [8, 7], PR: [11, 7],
  };

  // ---------- number parsing / formatting ----------

  function parseNumber(raw) {
    let digits = (raw || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (digits.length !== 10) {
      return { error: "Enter a 10-digit US/Canada phone number." };
    }
    if (!/^[2-9]/.test(digits)) {
      return { error: "Area codes can't start with 0 or 1 — double-check the number." };
    }
    if (!/^[2-9]/.test(digits.slice(3, 4))) {
      return { error: "That's not a valid North American number (the digit after the area code can't be 0 or 1)." };
    }
    return { digits };
  }

  const dashed = (d) => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  const pretty = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;

  function formatAsYouType(value) {
    let d = value.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    d = d.slice(0, 10);
    if (d.length > 6) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length > 3) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return d;
  }

  input.addEventListener("input", () => {
    const pos = input.selectionStart === input.value.length;
    input.value = formatAsYouType(input.value);
    if (pos) input.setSelectionRange(input.value.length, input.value.length);
  });

  // ---------- data fetching ----------

  async function fetchAreaCodes() {
    if (areaCodes) return areaCodes;
    try {
      const res = await fetch("data/areacodes.json");
      areaCodes = await res.json();
    } catch {
      areaCodes = { codes: {} }; // area code info is a nice-to-have; don't block the lookup
    }
    return areaCodes;
  }

  async function fetchNxx(npa) {
    if (npa in nxxCache) return nxxCache[npa];
    try {
      const res = await fetch(`data/nxx/${npa}.json`);
      nxxCache[npa] = res.ok ? await res.json() : null;
    } catch {
      nxxCache[npa] = null; // carrier info is a nice-to-have; don't block the lookup
    }
    return nxxCache[npa];
  }

  async function fetchComplaints(digits) {
    const num = dashed(digits);
    const where = `caller_id_number='${num}' OR advertiser_business_phone_number='${num}'`;
    const detailUrl =
      `${FCC_API}?$where=${encodeURIComponent(where)}` +
      `&$select=${encodeURIComponent("issue_date,type_of_call_or_messge,method,state,issue")}` +
      `&$order=${encodeURIComponent("issue_date DESC")}&$limit=${MAX_DETAIL_ROWS}`;
    const countUrl = `${FCC_API}?$select=count(*)&$where=${encodeURIComponent(where)}`;

    const [detailRes, countRes] = await Promise.all([fetch(detailUrl), fetch(countUrl)]);
    if (!detailRes.ok || !countRes.ok) {
      throw new Error(`FCC API returned ${detailRes.ok ? countRes.status : detailRes.status}`);
    }
    const rows = await detailRes.json();
    const countJson = await countRes.json();
    const total = parseInt(countJson?.[0]?.count ?? rows.length, 10) || rows.length;

    // The dataset has some junk dates (e.g. year 9999); drop anything implausible.
    const nowYear = new Date().getFullYear();
    const clean = rows.filter((r) => {
      const y = new Date(r.issue_date).getFullYear();
      return y >= 2000 && y <= nowYear;
    });
    return { rows: clean, total: total - (rows.length - clean.length) };
  }

  // ---------- rendering ----------

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function dlRow(dt, dd) {
    const div = document.createElement("div");
    div.append(el("dt", dt), el("dd", dd));
    return div;
  }

  function verdictFor(total, rows) {
    const now = Date.now();
    const yearMs = 365 * 24 * 3600 * 1000;
    const recent = rows.filter((r) => now - new Date(r.issue_date).getTime() < 2 * yearMs).length;

    if (total === 0) {
      return {
        cls: "ok", icon: "✅", title: "No complaints on file",
        sub: "Nobody has reported this number to the FCC. That's a good sign — but spammers rotate and spoof numbers, so stay skeptical of unknown callers.",
      };
    }
    if (total >= 10 && recent > 0) {
      return {
        cls: "bad", icon: "🚨", title: "Very likely spam",
        sub: `${total} federal complaint${total === 1 ? "" : "s"} on file, including recent activity. Strongly consider blocking this number.`,
      };
    }
    if (total >= 3) {
      return {
        cls: recent > 0 ? "bad" : "warn",
        icon: recent > 0 ? "🚨" : "⚠️",
        title: recent > 0 ? "Likely spam" : "Past spam reports",
        sub: recent > 0
          ? `${total} people have reported this number to the FCC. Treat calls from it with suspicion.`
          : `${total} complaints on file, but none recently — the number may have been reassigned since.`,
      };
    }
    return {
      cls: "warn", icon: "⚠️", title: "A few complaints on file",
      sub: `${total} complaint${total === 1 ? "" : "s"} reported to the FCC. Could be spam, could be a one-off — see the details below.`,
    };
  }

  const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  function renderNumberInfo(digits, nxx) {
    const dl = $("number-info");
    dl.replaceChildren();
    dl.append(dlRow("Number", pretty(digits)));

    const info = areaCodes?.codes?.[digits.slice(0, 3)];
    if (info) {
      if (info.service) {
        dl.append(dlRow("Type", info.service));
      } else if (info.loc) {
        const loc = info.loc.length <= 2 ? info.loc : titleCase(info.loc);
        dl.append(dlRow("Area code region", loc + (info.country && info.country !== "US" ? `, ${titleCase(info.country)}` : "")));
      }
      if (info.tz && !info.service) {
        const tzNames = { E: "Eastern", C: "Central", M: "Mountain", P: "Pacific", A: "Atlantic", H: "Hawaii", AK: "Alaska", N: "Newfoundland" };
        dl.append(dlRow("Time zone", tzNames[info.tz] || info.tz));
      }
    } else {
      dl.append(dlRow("Area code", `${digits.slice(0, 3)} (not in the NANPA registry — suspicious)`));
    }

    const prefix = nxx?.[digits.slice(3, 6)];
    if (prefix) {
      const [rateCenter, carrier] = prefix;
      if (rateCenter) dl.append(dlRow("Prefix location", titleCase(rateCenter)));
      if (carrier) {
        const row = dlRow("Carrier (prefix owner)", titleCase(carrier));
        if (VOIP_CARRIERS.test(carrier)) {
          row.querySelector("dd").append(el("span", " — VoIP/wholesale, often used by robocallers", "carrier-flag"));
        }
        dl.append(row);
      }
    } else if (nxx && !areaCodes?.codes?.[digits.slice(0, 3)]?.service) {
      dl.append(dlRow("Prefix", `${digits.slice(0, 3)}-${digits.slice(3, 6)} is unassigned — a real call from it is almost certainly spoofed`));
    }
  }

  function renderStats(total, rows) {
    const dl = $("complaint-stats");
    dl.replaceChildren();
    dl.append(dlRow("Total FCC complaints", String(total) + (rows.length === MAX_DETAIL_ROWS ? "+" : "")));
    if (rows.length === 0) return;

    dl.append(dlRow("Most recent", new Date(rows[0].issue_date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })));

    const types = {};
    for (const r of rows) {
      const t = (r.type_of_call_or_messge || "Unknown").trim();
      types[t] = (types[t] || 0) + 1;
    }
    const top = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
    if (top) dl.append(dlRow("Most common type", `${top[0]} (${Math.round((100 * top[1]) / rows.length)}%)`));

    const states = new Set(rows.map((r) => r.state).filter(Boolean));
    if (states.size) dl.append(dlRow("Reported from", `${states.size} state${states.size === 1 ? "" : "s"}`));
  }

  function renderYearChart(rows) {
    const card = $("card-chart");
    const chart = $("year-chart");
    chart.replaceChildren();
    if (rows.length === 0) { card.hidden = true; return; }

    const byYear = {};
    for (const r of rows) {
      const y = new Date(r.issue_date).getFullYear();
      byYear[y] = (byYear[y] || 0) + 1;
    }
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b).slice(-8);
    const max = Math.max(...years.map((y) => byYear[y]));
    for (const y of years) {
      const wrap = el("div", null, "year-bar");
      const count = el("span", String(byYear[y]), "count");
      const bar = el("div", null, "bar");
      bar.style.height = `${Math.max(4, Math.round((byYear[y] / max) * 78))}%`;
      wrap.append(count, bar, el("span", String(y)));
      chart.append(wrap);
    }
    card.hidden = false;
  }

  function renderMap(rows) {
    const card = $("card-map");
    const wrap = $("state-map");
    wrap.replaceChildren();

    const byState = {};
    for (const r of rows) {
      const s = (r.state || "").trim().toUpperCase();
      if (STATE_TILES[s]) byState[s] = (byState[s] || 0) + 1;
    }
    const states = Object.keys(byState);
    if (states.length === 0) { card.hidden = true; return; }

    const max = Math.max(...states.map((s) => byState[s]));
    const SIZE = 46, GAP = 5;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${12 * (SIZE + GAP)} ${8 * (SIZE + GAP)}`);

    for (const [state, [col, row]] of Object.entries(STATE_TILES)) {
      const count = byState[state] || 0;
      const g = document.createElementNS(svgNS, "g");
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", col * (SIZE + GAP));
      rect.setAttribute("y", row * (SIZE + GAP));
      rect.setAttribute("width", SIZE);
      rect.setAttribute("height", SIZE);
      rect.setAttribute("rx", 6);
      rect.setAttribute("class", count ? "tile hit" : "tile");
      if (count) rect.setAttribute("fill-opacity", (0.25 + 0.75 * (count / max)).toFixed(2));

      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${state}: ${count} complaint${count === 1 ? "" : "s"}`;
      rect.append(title);
      g.append(rect);

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", col * (SIZE + GAP) + SIZE / 2);
      label.setAttribute("y", row * (SIZE + GAP) + (count ? SIZE / 2 - 3 : SIZE / 2 + 5));
      label.setAttribute("class", count ? "tile-label hit" : "tile-label");
      label.textContent = state;
      g.append(label);

      if (count) {
        const num = document.createElementNS(svgNS, "text");
        num.setAttribute("x", col * (SIZE + GAP) + SIZE / 2);
        num.setAttribute("y", row * (SIZE + GAP) + SIZE / 2 + 15);
        num.setAttribute("class", "tile-count");
        num.textContent = count;
        g.append(num);
      }
      svg.append(g);
    }
    wrap.append(svg);
    card.hidden = false;
  }

  function renderReport(digits, total) {
    $("report-number-text").textContent = pretty(digits);
    const cta = $("verdict-report");
    cta.hidden = total === 0;

    const copyBtn = $("copy-number");
    copyBtn.textContent = "Copy number";
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(dashed(digits));
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy number"; }, 1600);
      } catch {
        copyBtn.textContent = dashed(digits); // clipboard blocked — at least show it selectable
      }
    };
  }

  function renderTable(rows, total) {
    const card = $("card-list");
    const tbody = $("complaint-table").querySelector("tbody");
    tbody.replaceChildren();
    if (rows.length === 0) { card.hidden = true; return; }

    for (const r of rows.slice(0, RECENT_ROWS_SHOWN)) {
      const tr = document.createElement("tr");
      tr.append(
        el("td", new Date(r.issue_date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })),
        el("td", r.type_of_call_or_messge || "—"),
        el("td", r.method || "—"),
        el("td", r.state || "—"),
      );
      tbody.append(tr);
    }
    $("list-note").textContent = total > RECENT_ROWS_SHOWN ? `(showing ${Math.min(RECENT_ROWS_SHOWN, rows.length)} of ${total})` : "";
    card.hidden = false;
  }

  function renderActions(digits) {
    const wrap = $("action-links");
    wrap.replaceChildren();
    const links = [
      [`Google this number`, `https://www.google.com/search?q=${encodeURIComponent(`"${dashed(digits)}" OR "${pretty(digits)}"`)}`],
      ["Join the Do Not Call registry", "https://www.donotcall.gov/register.html"],
    ];
    for (const [label, href] of links) {
      const a = el("a", label);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      wrap.append(a);
    }
  }

  // ---------- main flow ----------

  async function lookup(digits) {
    errorEl.hidden = true;
    results.hidden = true;
    loading.hidden = false;
    btn.disabled = true;
    try {
      const [, nxx, complaints] = await Promise.all([
        fetchAreaCodes(),
        fetchNxx(digits.slice(0, 3)),
        fetchComplaints(digits),
      ]);
      const { rows, total } = complaints;

      const v = verdictFor(total, rows);
      const verdict = $("verdict");
      verdict.className = `verdict ${v.cls}`;
      $("verdict-icon").textContent = v.icon;
      $("verdict-title").textContent = v.title;
      $("verdict-sub").textContent = v.sub;

      renderNumberInfo(digits, nxx);
      renderStats(total, rows);
      renderYearChart(rows);
      renderMap(rows);
      renderTable(rows, total);
      renderReport(digits, total);
      renderActions(digits);

      results.hidden = false;
      history.replaceState(null, "", `#${dashed(digits)}`);
    } catch (err) {
      errorEl.textContent = `Couldn't reach the FCC complaint database (${err.message}). Try again in a minute.`;
      errorEl.hidden = false;
    } finally {
      loading.hidden = true;
      btn.disabled = false;
    }
  }

  $("verdict-report").addEventListener("click", () => {
    $("card-report").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const { digits, error } = parseNumber(input.value);
    if (error) {
      errorEl.textContent = error;
      errorEl.hidden = false;
      results.hidden = true;
      return;
    }
    lookup(digits);
  });

  // Support shareable links: whocalled.example/#555-123-4567
  const fromHash = parseNumber(decodeURIComponent(location.hash.slice(1)));
  if (fromHash.digits) {
    input.value = formatAsYouType(fromHash.digits);
    lookup(fromHash.digits);
  }
})();
