"""
Export the data the First 1-Minute ATM CE + PE Premium Hedge backtest needs from the NIFTY 50 five-year master dataset
(Dhan HQ v2). Nothing here is filled, modelled or filtered for the strategy beyond choosing the strike.

    python scripts/export-atm-hedge-data.py --out ../../backtests/ATM-Hedge-NIFTY-5y/data
    python scripts/export-atm-hedge-data.py --from 2025-11-13 --to 2026-11-12 --out <folder>

Writes:
  05-nifty-1min-candles.csv        NIFTY 50 spot, 1-minute, every session in the window
  08-atm-options-1min.csv          per session and per series (WEEK = nearest weekly, MONTH = nearest monthly): the ATM
                                   strike's CE and PE 1-minute candles for the whole session
  00-window.json                   window, and per session: 09:15 close, chosen strike, expiry per series, 09:15 VIX

Strike (the only choice made here, the same rule the live strategy uses): the first completed 1-minute NIFTY candle
(09:15, complete at 09:16) close, rounded to the nearest 50. If the series has no CE+PE candle at 09:16 for that strike
(possible on old monthly series with 100-pt strikes), the nearest strike that has both is used and that is written down.

Expiry: the NSE weekday rule (see expiry_calendar), checked against the master ATM straddle time-value collapse. The
master expiry_calendar_*.csv files are NOT used: they have detection gaps and false days.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import pandas as pd

MASTER = Path(__file__).resolve().parents[3] / "NIFTY50_5_YEAR_MASTER_DATA"
SERIES = {"WEEK": "WEEK_code1_near", "MONTH": "MONTH_code1_near"}
IST = "Asia/Kolkata"


def hm(ts: pd.Series) -> pd.Series:
    return ts.dt.tz_convert(IST).dt.strftime("%H:%M")


SWITCH = dt.date(2025, 9, 1)  # NIFTY weekly/monthly expiry weekday: Thursday before, Tuesday from Sep 2025


def rule_target(d: dt.date) -> dt.date:
    """The expiry weekday on or after d (Thursday; Tuesday once that Thursday falls on/after the switch)."""
    thu = d + dt.timedelta(days=(3 - d.weekday()) % 7)
    if thu < SWITCH:
        return thu
    return d + dt.timedelta(days=(1 - d.weekday()) % 7)


def expiry_calendar(full: list[dt.date], all_dates: list[dt.date]) -> tuple[dict[dt.date, dt.date], dict[dt.date, dt.date]]:
    """Weekly + monthly expiry per session from the NSE weekday rule: the expiry weekday, or the last full session
    before it when it is a holiday. From the week holding the last session on: the scrip-master snapshot. Monthly = the last weekly
    expiry of its calendar month. Validated against the master ATM straddle time-value collapse (see 00-window.json)."""
    last = max(full)
    week_exp: dict[dt.date, dt.date] = {}
    for d in full:
        t = rule_target(d)
        week_exp[t] = max(week_exp.get(t, d), d)
    # The expiry week holding the last session may be incomplete: from there on, take listed expiries from the
    # scrip-master snapshot (they carry real holiday shifts).
    cutoff = rule_target(last)
    weekly = sorted(e for t, e in week_exp.items() if t < cutoff)
    snap = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/listed_contracts_and_lot_sizes_snapshot.csv")
    listed = sorted({dt.date.fromisoformat(x) for x in snap.loc[snap["INSTRUMENT"] == "OPTIDX", "SM_EXPIRY_DATE"].astype(str)})
    weekly += [x for x in listed if x > weekly[-1]]
    by_month: dict[tuple[int, int], dt.date] = {}
    for e in weekly:
        by_month[(e.year, e.month)] = max(by_month.get((e.year, e.month), e), e)
    monthly = sorted(by_month.values())
    nxt = lambda lst, d: next((e for e in lst if e >= d), None)  # noqa: E731
    return {d: nxt(weekly, d) for d in all_dates}, {d: nxt(monthly, d) for d in all_dates}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="start")
    p.add_argument("--to", dest="end")
    p.add_argument("--out", required=True)
    p.add_argument("--step", type=int, default=50)
    a = p.parse_args()

    spot = pd.read_parquet(MASTER / "01_SPOT/processed/nifty_spot_1min.parquet")
    if a.start:
        spot = spot[spot["date"] >= dt.date.fromisoformat(a.start)]
    if a.end:
        spot = spot[spot["date"] <= dt.date.fromisoformat(a.end)]
    spot = spot.copy()
    spot["hm"] = hm(spot["timestamp"])
    first = spot.loc[spot["hm"] == "09:15"].set_index("date")["close"]

    vix = pd.read_parquet(MASTER / "04_INDIA_VIX/processed/india_vix_1min.parquet")
    vix = vix[hm(vix["timestamp"]) == "09:15"].set_index("date")["close"]

    tcal = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/trading_calendar.csv")
    tcal = {r.date: r.session_type for r in tcal.itertuples()}

    # expiry calendar from the FULL spot history (not just the window) so the holiday rule sees every session
    allspot = pd.read_parquet(MASTER / "01_SPOT/processed/nifty_spot_1min.parquet", columns=["date"])
    counts = allspot.groupby("date").size()
    full = [d for d, n in counts.items() if n >= 300 and tcal.get(d.isoformat()) != "short/special"]
    week_of, month_of = expiry_calendar(full, sorted(counts.index))
    wcal = pd.read_csv(MASTER / "06_HISTORICAL_METADATA/processed/expiry_calendar_WEEK_code1_near.csv")
    tv = dict(zip(wcal["date"], wcal["time_value_pct_of_spot"]))

    dates = sorted(spot["date"].unique())
    years = sorted({d.year for d in dates})
    iso_dates = [d.isoformat() for d in dates]
    sessions = {d: {"date": d, "session_type": tcal.get(d, "unknown"), "first_close": None, "atm50": None, "vix_0915": None, "series": {}} for d in iso_dates}
    for d in dates:
        s = sessions[d.isoformat()]
        if d in first.index:
            s["first_close"] = float(first[d])
            s["atm50"] = int(round(first[d] / a.step) * a.step)
        if d in vix.index:
            s["vix_0915"] = float(vix[d])

    rows = []
    for series, folder in SERIES.items():
        frames = []
        for right in ("CE", "PE"):
            for y in years:
                f = MASTER / f"02_OPTIONS/{right}/processed/rolling_1min/{folder}/{y}.parquet"
                if f.exists():
                    frames.append(pd.read_parquet(f, columns=["option_type", "strike", "timestamp", "date", "open", "high", "low", "close", "volume", "atm_offset"]))
        opt = pd.concat(frames, ignore_index=True)
        opt = opt[opt["date"].isin(set(dates))].copy()
        opt["hm"] = hm(opt["timestamp"])
        opt = opt.drop_duplicates(["timestamp", "strike", "option_type"])
        exp_of = week_of if series == "WEEK" else month_of
        # strikes with BOTH CE and PE at 09:16 (the entry minute), per date
        at916 = opt[opt["hm"] == "09:16"].groupby(["date", "strike"])["option_type"].nunique()
        both = at916[at916 == 2].reset_index().groupby("date")["strike"].apply(list).to_dict()
        chosen = {}
        for d in dates:
            iso = d.isoformat()
            s = sessions[iso]
            e = exp_of.get(d)
            info = {"expiry": e.isoformat() if e else None, "strike": None, "strike_rule": None}
            if s["atm50"] is not None and d in both:
                strikes = both[d]
                if s["atm50"] in strikes:
                    info["strike"], info["strike_rule"] = s["atm50"], "09:15 close → nearest 50"
                else:
                    k = min(strikes, key=lambda x: (abs(x - s["first_close"]), x))
                    info["strike"], info["strike_rule"] = int(k), f"nearest strike with CE+PE at 09:16 ({s['atm50']} not in tape)"
                chosen[d] = info["strike"]
            s["series"][series] = info
        key = pd.Series(chosen, dtype="float64")
        sel = opt[opt["strike"].values == opt["date"].map(key).values]
        rows.append(pd.DataFrame({
            "Date": sel["date"].astype(str), "Series": series, "Time (IST, candle open)": sel["hm"], "Strike": sel["strike"].astype(int),
            "Type": sel["option_type"], "Open": sel["open"], "High": sel["high"], "Low": sel["low"], "Close": sel["close"], "Volume": sel["volume"],
        }))
        print(f"{series}: {len(chosen)} sessions with a strike, {len(sel)} option rows")

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({
        "Date": spot["date"].astype(str), "Time (IST, candle open)": spot["hm"], "Open": spot["open"], "High": spot["high"], "Low": spot["low"], "Close": spot["close"],
    }).sort_values(["Date", "Time (IST, candle open)"]).to_csv(out / "05-nifty-1min-candles.csv", index=False)
    pd.concat(rows).sort_values(["Date", "Series", "Time (IST, candle open)", "Type"]).to_csv(out / "08-atm-options-1min.csv", index=False)
    # Calendar check: on a rule expiry day the weekly ATM straddle's time value at the close should be ~0 (< 0.25% of spot).
    in_win = set(iso_dates)
    rule_days = sorted({e.isoformat() for e in week_of.values() if e and e.isoformat() in in_win})
    check = {
        "rule": "Thursday expiry to Aug 2025, Tuesday from Sep 2025; holiday → previous full session; monthly = last weekly expiry of the month",
        "weekly_expiry_days_in_window": len(rule_days),
        "rule_days_time_value_not_collapsed": [(d, tv.get(d)) for d in rule_days if not (tv.get(d) is not None and tv.get(d) < 0.25)],
        "non_rule_days_time_value_below_0.25pct": [(d, v) for d, v in tv.items() if d in in_win and v < 0.25 and d not in rule_days],
    }
    (out / "00-window.json").write_text(json.dumps({
        "source": str(MASTER), "start": iso_dates[0], "end": iso_dates[-1], "expiry_calendar_check": check, "sessions": list(sessions.values()),
    }, indent=1, default=str), encoding="utf-8")
    print(f"{iso_dates[0]} .. {iso_dates[-1]}: {len(dates)} sessions -> {out}")


if __name__ == "__main__":
    main()
