"""
Export the data the 1-Hour Fibonacci Breakout backtest needs from the NIFTY 50 five-year master dataset (Dhan HQ v2).

    python scripts/export-fib-breakout-data.py --months 1 --out ../../backtests/Fib-Breakout-1H-NIFTY/data
    python scripts/export-fib-breakout-data.py --from 2026-10-13 --to 2026-11-12 --out <folder>

Nothing here is filtered for the strategy, filled or modelled. It writes:
  05-nifty-1min-candles.csv           NIFTY 50 spot, 1-minute, every session in the window (special sessions included)
  07-nifty-weekly-options-1min.csv    nearest WEEKLY expiry, every strike the API returned (ATM±10), CE and PE, 1-minute,
                                      with the API's own ATM offset label and spot for that minute
  00-window.json                      window, sessions, expiry per session and how it was found

Expiry per session: 06_HISTORICAL_METADATA expiry_calendar_WEEK_code1_near.csv (expiry detected from the option prices).
Sessions after the last detected expiry have none there; for those the earliest listed weekly OPTIDX expiry on or after
the date from the scrip-master snapshot is used, and that is written down per session.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

MASTER = Path(__file__).resolve().parents[3] / "NIFTY50_5_YEAR_MASTER_DATA"
# Sessions the master calendar wrongly flags as weekly expiry days (found in the NIFTY APEX audit, 2026-11-15).
FALSE_EXPIRIES = {
    "2026-08-03": "false detection: a +201-pt 15:29 spot print; CE/PE still ₹50–60 at the close; the real expiry is Tue 2026-08-04",
}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="start")
    p.add_argument("--to", dest="end")
    p.add_argument("--months", type=int, default=1)
    p.add_argument("--out", required=True)
    p.add_argument("--expiry-rule", action="store_true", help="weekly expiry by the Thursday/Tuesday rule (cross-checked with the master calendar)")
    p.add_argument("--atm-time", default="09:15", help="NIFTY 1-minute candle whose close sets the ATM for --atm-only (10:14 = first hour; 09:15 = first minute)")
    p.add_argument("--atm-only", action="store_true", help="keep only each session's ATM strike (NIFTY 10:14 close → nearest 50), CE and PE")
    a = p.parse_args()

    spot = pd.read_parquet(MASTER / "01_SPOT/processed/nifty_spot_1min.parquet")
    years = sorted({int(a.start[:4])} | {int((a.end or "2100")[:4])}) if a.start else None
    frames = []
    for right in ("CE", "PE"):
        folder = MASTER / f"02_OPTIONS/{right}/processed/rolling_1min/WEEK_code1_near"
        files = sorted(folder.glob("*.parquet"))
        if years:
            files = [f for f in files if int(f.stem) in years or (int(f.stem) >= years[0] and int(f.stem) <= years[-1])]
        else:
            files = files[-2:]
        frames += [pd.read_parquet(f) for f in files]
    opt = pd.concat(frames, ignore_index=True)

    # Window: the latest date with BOTH spot and options, back one calendar month (inclusive), unless given.
    last = min(spot["date"].max(), opt["date"].max())
    end = dt.date.fromisoformat(a.end) if a.end else last
    if a.start:
        start = dt.date.fromisoformat(a.start)
    else:
        m = end.month - a.months
        y = end.year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        start = dt.date(y, m, min(end.day, 28)) + dt.timedelta(days=1)
        if end.day > 28:  # keep "one month back" exact for day 29–31
            start = dt.date(y, m, 28) + dt.timedelta(days=end.day - 28 + 1)
    spot = spot[(spot["date"] >= start) & (spot["date"] <= end)].copy()
    # Older master spot files also hold pre-/post-market candles (from ~07:00): keep the regular session 09:15–15:29 only.
    _hm = spot["timestamp"].dt.tz_convert("Asia/Kolkata").dt.strftime("%H:%M")
    spot = spot[(_hm >= "09:15") & (_hm <= "15:29")].copy()
    opt = opt[(opt["date"] >= start) & (opt["date"] <= end)].copy()
    if a.atm_only:
        hm = spot["timestamp"].dt.tz_convert("Asia/Kolkata").dt.strftime("%H:%M")
        close_1014 = spot.loc[hm == a.atm_time].set_index("date")["close"]
        atm = np.floor(close_1014 / 50 + 0.5).mul(50)        # round half UP, exactly like the backtest (Math.round)
        opt = opt[opt["strike"].values == opt["date"].map(atm).values].copy()

    cal_df = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/expiry_calendar_WEEK_code1_near.csv")
    cal = {r.date: (r.expiry_date_detected if isinstance(r.expiry_date_detected, str) else None) for r in cal_df.itertuples()}
    # Known false detections: a session wrongly flagged as an expiry day; those sessions take the next real expiry.
    real_expiries = sorted(d for d in cal_df.loc[cal_df["is_expiry_day_detected"] == True, "date"] if d not in FALSE_EXPIRIES)  # noqa: E712
    fixed: dict[str, str] = {}
    for d, exp in list(cal.items()):
        if exp in FALSE_EXPIRIES:
            nxt = next((x for x in real_expiries if x > exp), None)
            cal[d] = nxt
            fixed[d] = f"{exp} → {nxt} ({FALSE_EXPIRIES[exp]})"
    snap = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/listed_contracts_and_lot_sizes_snapshot.csv")
    listed = sorted(snap.loc[snap["INSTRUMENT"] == "OPTIDX", "SM_EXPIRY_DATE"].astype(str))
    tcal = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/trading_calendar.csv")
    tcal = {r.date: r.session_type for r in tcal.itertuples()}

    rule_audit = None
    if a.expiry_rule:
        # Weekly expiry by rule (NIFTY APEX audit): Thursday up to 31-Aug-2025, Tuesday from 1-Sep-2025, moved to the last
        # regular session on or before that weekday when it is a holiday. The master's price-detected calendar is only
        # used to cross-check (it missed Thursday expiries in 2021-24 and flagged 2026-08-03 falsely).
        tc = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/trading_calendar.csv")
        reg = sorted(dt.date.fromisoformat(d) for d in tc.loc[tc["spot_1min_candles_0915_1529"] >= 300, "date"])
        weeks: dict[dt.date, dt.date] = {}
        for d in reg:
            wd = 3 if d <= dt.date(2025, 8, 31) else 1
            if d.weekday() <= wd:
                ew = d + dt.timedelta(days=wd - d.weekday())
                weeks[ew] = max(weeks.get(ew, d), d)
        rule = sorted(weeks.values())
        detected = {r.date for r in cal_df.itertuples() if r.is_expiry_day_detected == True}  # noqa: E712
        lo, hi = start.isoformat(), end.isoformat()
        rule_iso = {d.isoformat() for d in rule if start <= d <= end}
        det_iso = {d for d in detected if lo <= d <= hi}
        rule_audit = {"rule_expiries_in_window": len(rule_iso), "master_detected_in_window": len(det_iso),
                      "rule_not_detected_by_master": sorted(rule_iso - det_iso), "master_detected_not_rule": sorted(det_iso - rule_iso)}
        last_rule = rule[-1]
        for d in reg:
            if d > last_rule:
                cal[d.isoformat()] = None            # after the last session in the calendar: scrip-master snapshot below
                continue
            cal[d.isoformat()] = next(x for x in rule if x >= d).isoformat()
        fixed = {}
        print(f"expiry rule: {len(rule_iso)} expiries in window; master missed {len(rule_audit['rule_not_detected_by_master'])}, master extra {len(rule_audit['master_detected_not_rule'])}")

    sessions = []
    expiry_of: dict[str, str] = {}
    for d in sorted(spot["date"].unique()):
        iso = d.isoformat()
        exp, how = cal.get(iso), ("weekly-expiry rule (Thu to Aug-2025, Tue from Sep-2025, holiday → previous session)" if a.expiry_rule else "expiry_calendar_WEEK_code1_near (detected from option prices)") + (f"; corrected {fixed[iso]}" if iso in fixed else "")
        if exp is None:
            exp = next((x for x in listed if x >= iso), None)
            how = "scrip-master snapshot: earliest listed weekly OPTIDX expiry on/after the date"
        expiry_of[iso] = exp or "unknown"
        sessions.append({"date": iso, "session_type": tcal.get(iso, "unknown"), "expiry": exp, "expiry_source": how})

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t = spot["timestamp"].dt.tz_convert("Asia/Kolkata")
    pd.DataFrame({
        "Date": spot["date"].astype(str), "Time (IST, candle open)": t.dt.strftime("%H:%M"),
        "Open": spot["open"], "High": spot["high"], "Low": spot["low"], "Close": spot["close"],
    }).sort_values(["Date", "Time (IST, candle open)"]).to_csv(out / "05-nifty-1min-candles.csv", index=False)

    t = opt["timestamp"].dt.tz_convert("Asia/Kolkata")
    dates = opt["date"].astype(str)
    pd.DataFrame({
        "Date": dates, "Time (IST, candle open)": t.dt.strftime("%H:%M"), "Weekly expiry": dates.map(expiry_of),
        "Strike": opt["strike"].astype(int), "Type": opt["option_type"], "Open": opt["open"], "High": opt["high"],
        "Low": opt["low"], "Close": opt["close"], "Volume": opt["volume"], "ATM offset (API)": opt["atm_offset"],
        "Spot (API)": opt["spot"],
    }).sort_values(["Date", "Time (IST, candle open)", "Type", "Strike"]).to_csv(out / "07-nifty-weekly-options-1min.csv", index=False)

    dup = int(opt.duplicated(["timestamp", "strike", "option_type"]).sum())
    (out / "00-window.json").write_text(json.dumps({
        "source": str(MASTER), "series": "WEEK expiryCode 1 (near)", "start": start.isoformat(), "end": end.isoformat(),
        "latest_date_in_master": last.isoformat(), "spot_rows": len(spot), "option_rows": len(opt),
        "duplicate_option_minutes": dup, "expiry_rule_audit": rule_audit, "lot_size_snapshot": snap.loc[snap["INSTRUMENT"] == "OPTIDX", "lot_size"].iloc[0].item(),
        "lot_size_snapshot_date": str(snap["snapshot_date"].iloc[0]), "sessions": sessions,
    }, indent=2), encoding="utf-8")
    print(f"{start} .. {end}: {len(sessions)} sessions, {len(spot)} spot rows, {len(opt)} option rows, {dup} duplicates -> {out}")


if __name__ == "__main__":
    main()
