"""
Fetch one session from Dhan HQ v2 for the 1-Hour Fibonacci Breakout backtest (a day newer than the master dataset).

    python scripts/fetch-fib-day.py --date 2026-11-16 --sides CE --out ../../backtests/Fib-Breakout-1H-NIFTY-2026-11-16/data

1. NIFTY 50 spot 1-minute candles (/charts/intraday, IDX_I 13).
2. ATM = the 10:14 candle's close (the first hour's close) rounded to the nearest 50.
3. The ATM contract(s) of the nearest weekly expiry on/after the date, by security id from the saved scrip master
   (06_HISTORICAL_METADATA/processed/instruments, latest snapshot), 1-minute candles (/charts/intraday, NSE_FNO).
Writes 05-nifty-1min-candles.csv, 07-nifty-weekly-options-1min.csv and 00-window.json in the backtest format.
Credentials come from the downloader (DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN, env or 00_DOWNLOADER/credentials.env); the
token is never printed. Read-only data requests: no order is placed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import pandas as pd
import requests

MASTER = Path(__file__).resolve().parents[3] / "NIFTY50_5_YEAR_MASTER_DATA"
sys.path.insert(0, str(MASTER / "00_DOWNLOADER"))
from nifty_dl.client import load_credentials  # noqa: E402

API = "https://api.dhan.co/v2/charts/intraday"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def intraday(headers: dict, security_id: str, segment: str, instrument: str, day: str, oi: bool) -> pd.DataFrame:
    # A same-day from/to returns nothing on this account; ask up to the next day and keep only `day`'s session.
    nxt = (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()
    body = {"securityId": security_id, "exchangeSegment": segment, "instrument": instrument, "interval": "1", "oi": oi,
            "fromDate": f"{day} 09:00:00", "toDate": f"{nxt} 09:00:00"}  # a 09:15 start drops the 09:15 candle
    r = requests.post(API, json=body, headers=headers, timeout=30)
    data = r.json() if r.content else {}
    if r.status_code != 200 or "timestamp" not in data:
        raise SystemExit(f"Dhan {segment} {security_id}: HTTP {r.status_code} {str(data)[:300]}")
    df = pd.DataFrame({k: data[k] for k in ("timestamp", "open", "high", "low", "close", "volume") if k in data})
    t = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST)
    df["Date"], df["Time"] = t.dt.strftime("%Y-%m-%d"), t.dt.strftime("%H:%M")
    return df[(df["Date"] == day) & (df["Time"] >= "09:15") & (df["Time"] <= "15:29")].reset_index(drop=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--date", required=True)
    p.add_argument("--sides", default="CE,PE")
    p.add_argument("--out", required=True)
    p.add_argument("--atm-time", default="09:15", help="NIFTY candle whose close sets the ATM (10:14 first hour, 09:15 first minute)")
    p.add_argument("--append", action="store_true", help="add the day to an existing export folder")
    a = p.parse_args()
    client_id, token = load_credentials()
    headers = {"Accept": "application/json", "Content-Type": "application/json", "access-token": token, "client-id": client_id}

    spot = intraday(headers, "13", "IDX_I", "INDEX", a.date, False)
    if spot.empty:
        raise SystemExit(f"No NIFTY candles for {a.date} (holiday, or not yet available).")
    close_row = spot[spot["Time"] == a.atm_time]
    if close_row.empty:
        raise SystemExit(f"No NIFTY {a.atm_time} candle: the reference close is unknown.")
    spot_close = float(close_row["close"].iloc[0])
    strike = int(math.floor(spot_close / 50 + 0.5) * 50)      # round half UP, like the backtest

    snaps = sorted((MASTER / "06_HISTORICAL_METADATA/processed/instruments").glob("nifty_instruments_*.csv"))
    inst = pd.read_csv(snaps[-1])
    opt = inst[(inst["INSTRUMENT"] == "OPTIDX") & (inst["SM_EXPIRY_DATE"].astype(str) >= a.date) & (inst["EXPIRY_FLAG"] == "W")]
    expiry = sorted(opt["SM_EXPIRY_DATE"].astype(str).unique())[0]
    rows, contracts = [], []
    for side in a.sides.split(","):
        hit = opt[(opt["SM_EXPIRY_DATE"].astype(str) == expiry) & (opt["STRIKE_PRICE"] == strike) & (opt["OPTION_TYPE"] == side)]
        if hit.empty:
            raise SystemExit(f"{strike} {side} {expiry} not in the scrip master {snaps[-1].name}.")
        sid = str(int(hit["SECURITY_ID"].iloc[0]))
        df = intraday(headers, sid, "NSE_FNO", "OPTIDX", a.date, True)
        contracts.append({"side": side, "strike": strike, "expiry": expiry, "security_id": sid, "display": hit["DISPLAY_NAME"].iloc[0],
                          "lot_size": int(hit["LOT_SIZE"].iloc[0]), "minutes": len(df)})
        rows.append(pd.DataFrame({"Date": df["Date"], "Time (IST, candle open)": df["Time"], "Weekly expiry": expiry, "Strike": strike,
                                  "Type": side, "Open": df["open"], "High": df["high"], "Low": df["low"], "Close": df["close"],
                                  "Volume": df["volume"], "ATM offset (API)": "", "Spot (API)": ""}))

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    spot_out = spot.rename(columns={"Time": "Time (IST, candle open)", "open": "Open", "high": "High", "low": "Low", "close": "Close"})[
        ["Date", "Time (IST, candle open)", "Open", "High", "Low", "Close"]]
    opt_out = pd.concat(rows)
    session = {"date": a.date, "session_type": "regular" if len(spot) >= 300 else "short", "expiry": expiry,
               "expiry_source": f"Dhan /charts/intraday + scrip master {snaps[-1].name}: earliest listed weekly expiry on/after the date",
               "atm": strike, "spot_close_1014": spot_close, "contracts": contracts}
    if a.append:
        # Add this session to an existing export (e.g. the master-data month), replacing the date if already there.
        window = json.loads((out / "00-window.json").read_text(encoding="utf-8"))
        old_spot = pd.read_csv(out / "05-nifty-1min-candles.csv", encoding="utf-8-sig")
        old_opt = pd.read_csv(out / "07-nifty-weekly-options-1min.csv", encoding="utf-8-sig")
        old_spot.columns, old_opt.columns = spot_out.columns, opt_out.columns
        pd.concat([old_spot[old_spot["Date"] != a.date], spot_out]).sort_values(["Date", "Time (IST, candle open)"]).to_csv(out / "05-nifty-1min-candles.csv", index=False)
        pd.concat([old_opt[old_opt["Date"] != a.date], opt_out]).sort_values(["Date", "Time (IST, candle open)", "Type", "Strike"]).to_csv(out / "07-nifty-weekly-options-1min.csv", index=False)
        window["sessions"] = sorted([s for s in window["sessions"] if s["date"] != a.date] + [session], key=lambda s: s["date"])
        window["end"] = max(window["end"], a.date)
        window["latest_date_in_master"] = max(window["latest_date_in_master"], a.date)
        window.setdefault("appended_from_dhan", []).append(a.date)
        (out / "00-window.json").write_text(json.dumps(window, indent=2), encoding="utf-8")
        print(f"{a.date} appended: NIFTY 10:14 close {spot_close} -> ATM {strike}, expiry {expiry}; " +
              ", ".join(f"{c['display']} {c['minutes']} min" for c in contracts))
        return
    spot_out.to_csv(out / "05-nifty-1min-candles.csv", index=False)
    opt_out.to_csv(out / "07-nifty-weekly-options-1min.csv", index=False)
    (out / "00-window.json").write_text(json.dumps({
        "source": "Dhan HQ v2 /charts/intraday (fetched " + dt.datetime.now(IST).isoformat(timespec="seconds") + ")",
        "start": a.date, "end": a.date, "latest_date_in_master": a.date, "duplicate_option_minutes": 0,
        "lot_size_snapshot": contracts[0]["lot_size"], "lot_size_snapshot_date": snaps[-1].stem.split("_")[-1],
        "spot_minutes": len(spot), "spot_close_1014": spot_close, "atm": strike, "contracts": contracts,
        "sessions": [{"date": a.date, "session_type": "regular" if len(spot) >= 300 else "short", "expiry": expiry,
                      "expiry_source": f"scrip master {snaps[-1].name}: earliest listed weekly expiry on/after the date"}],
    }, indent=2), encoding="utf-8")
    print(f"{a.date}: NIFTY {len(spot)} min, 10:14 close {spot_close} -> ATM {strike}, expiry {expiry}; " +
          ", ".join(f"{c['display']} id {c['security_id']} {c['minutes']} min" for c in contracts))


if __name__ == "__main__":
    main()
