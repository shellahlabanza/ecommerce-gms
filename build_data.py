"""
build_data.py
--------------
Statistical processing layer for the GA4 Analytics Dashboard.

What it does:
1. Loads the cleaned event-level CSV (BigQuery_4M_100k_cleaned.csv, the
   Google Analytics 4 / BigQuery export sample of the Google Merchandise Store).
2. Normalizes the fields used by the dashboard. The CSV is already cleaned, so
   this step only fills display placeholders. The 10 purchase events whose
   revenue is missing (purchase_missing_revenue = True) are kept as orders but
   left out of the revenue statistics, giving the same 123 orders used in the
   Problem Statement.
3. Computes descriptive statistics across the four families the dashboard is
   organized around:
       - Frequency   (counts / distributions of categorical fields)
       - Central tendency (mean, median, mode)
       - Dispersion  (range, variance, std dev, IQR)
       - Position    (quartiles / percentiles, rank)
4. Encodes the cleaned event table as compact integer-coded rows (categorical
   strings -> lookup-table indices, dates -> day-index) so the browser can
   filter by date range and re-aggregate instantly without a live backend.
5. Writes:
       data.json         -> everything the dashboard needs at runtime
       stats_report.md    -> human-readable descriptive statistics report

Run:
    python3 build_data.py                      # finds the cleaned CSV automatically
    python3 build_data.py path/to/cleaned.csv  # or point to it explicitly
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
CSV_NAME = "BigQuery_4M_100k_cleaned.csv"
# Looked for in this folder first, then in the parent folder.
SRC_CANDIDATES = [HERE / CSV_NAME, HERE.parent / CSV_NAME]
OUT_JSON = Path(__file__).parent / "data.json"
OUT_REPORT = Path(__file__).parent / "stats_report.md"

CATEGORICAL_COLS = [
    "event_name", "device_category", "operating_system", "browser",
    "mobile_brand_name", "continent", "sub_continent", "country",
    "source_name", "medium", "source", "channel_group",
]

FUNNEL_STEPS = [
    "session_start", "view_item", "add_to_cart",
    "begin_checkout", "add_payment_info", "purchase",
]


# ---------------------------------------------------------------------------
# Descriptive statistics helpers
# ---------------------------------------------------------------------------

def central_tendency(series: pd.Series) -> dict:
    s = series.dropna()
    mode = s.mode()
    return {
        "mean": round(float(s.mean()), 2) if len(s) else None,
        "median": round(float(s.median()), 2) if len(s) else None,
        "mode": round(float(mode.iloc[0]), 2) if len(mode) else None,
    }


def dispersion(series: pd.Series) -> dict:
    s = series.dropna()
    if len(s) < 2:
        return {"range": None, "variance": None, "std_dev": None, "iqr": None}
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    return {
        "range": round(float(s.max() - s.min()), 2),
        "variance": round(float(s.var()), 2),
        "std_dev": round(float(s.std()), 2),
        "iqr": round(float(q3 - q1), 2),
    }


def position(series: pd.Series) -> dict:
    s = series.dropna()
    if len(s) == 0:
        return {"min": None, "p25": None, "p50": None, "p75": None, "p90": None, "max": None}
    return {
        "min": round(float(s.min()), 2),
        "p25": round(float(s.quantile(0.25)), 2),
        "p50": round(float(s.quantile(0.50)), 2),
        "p75": round(float(s.quantile(0.75)), 2),
        "p90": round(float(s.quantile(0.90)), 2),
        "max": round(float(s.max()), 2),
    }


def full_stats_block(series: pd.Series) -> dict:
    return {
        "frequency_n": int(series.dropna().shape[0]),
        **central_tendency(series),
        **dispersion(series),
        **position(series),
    }


# ---------------------------------------------------------------------------
# Load + clean
# ---------------------------------------------------------------------------

def find_source() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    for p in SRC_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(
        f"{CSV_NAME} not found. Put it in {HERE} or its parent folder, "
        "or pass the path: python3 build_data.py path/to/file.csv")


def load_clean(src: Path):
    df = pd.read_csv(src, low_memory=False)

    for c in CATEGORICAL_COLS:
        df[c] = df[c].fillna("(not set)")

    df["is_purchase_event"] = df["event_name"].eq("purchase")
    # Revenue only exists on purchase events. Non-purchase events get 0 so daily
    # totals add up; purchases with missing revenue stay NaN (excluded from stats).
    df.loc[~df["is_purchase_event"], "purchase_revenue"] = 0.0
    # The cleaned CSV fills the 10 missing revenues with the $50 median and flags
    # them in purchase_missing_revenue. Undo that fill so the statistics use only
    # real revenue (123 orders), matching the Problem Statement.
    if "purchase_missing_revenue" in df.columns:
        flag = df["purchase_missing_revenue"].astype(str).str.lower().eq("true")
        df.loc[flag, "purchase_revenue"] = float("nan")
    df["total_item_quantity"] = df["total_item_quantity"].fillna(0)
    df["unique_items"] = df["unique_items"].fillna(0)
    df["event_date"] = pd.to_datetime(df["event_date"]).dt.strftime("%Y-%m-%d")

    return df


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def write_report(df: pd.DataFrame):
    lines = []
    lines.append("# Descriptive Statistics Report")
    lines.append(f"\nGenerated: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"\nRows: {len(df):,}  |  Unique users: {df['user_pseudo_id'].nunique():,}  "
                  f"|  Date range: {df['event_date'].min()} to {df['event_date'].max()}")
    n_orders = int(df["is_purchase_event"].sum())
    n_missing = int(df.loc[df["is_purchase_event"], "purchase_revenue"].isna().sum())
    lines.append(f"\nPurchases: {n_orders}  |  With revenue: {n_orders - n_missing}  "
                  f"|  Missing revenue (excluded from revenue stats): {n_missing}")

    lines.append("\n## Frequency — top categories\n")
    for c in ["event_name", "device_category", "operating_system", "browser",
              "country", "channel_group"]:
        vc = df[c].value_counts().head(5)
        lines.append(f"**{c}**")
        for k, v in vc.items():
            lines.append(f"- {k}: {v:,} ({v/len(df)*100:.1f}%)")
        lines.append("")

    lines.append("## Central tendency, dispersion & position — numeric fields\n")
    for col, label in [
        ("purchase_revenue", "Purchase revenue (purchase events only, USD)"),
        ("total_item_quantity", "Items per purchase"),
        ("unique_items", "Unique SKUs per purchase"),
    ]:
        s = df.loc[df["is_purchase_event"], col]  # NaN revenue is dropped by the stats helpers
        stats = full_stats_block(s)
        lines.append(f"**{label}**  (n={stats['frequency_n']})")
        lines.append(f"- Mean: {stats['mean']}  Median: {stats['median']}  Mode: {stats['mode']}")
        lines.append(f"- Range: {stats['range']}  Std dev: {stats['std_dev']}  Variance: {stats['variance']}  IQR: {stats['iqr']}")
        lines.append(f"- Min: {stats['min']}  P25: {stats['p25']}  P50: {stats['p50']}  P75: {stats['p75']}  P90: {stats['p90']}  Max: {stats['max']}")
        lines.append("")

    events_per_user = df.groupby("user_pseudo_id").size()
    stats = full_stats_block(events_per_user)
    lines.append(f"**Events per user** (n={stats['frequency_n']})")
    lines.append(f"- Mean: {stats['mean']}  Median: {stats['median']}  Mode: {stats['mode']}")
    lines.append(f"- Range: {stats['range']}  Std dev: {stats['std_dev']}  IQR: {stats['iqr']}")
    lines.append("")

    OUT_REPORT.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# Compact encoding for the browser
# ---------------------------------------------------------------------------

def build_payload(df: pd.DataFrame) -> dict:
    lookups, codes = {}, {}
    for c in CATEGORICAL_COLS:
        vals = sorted(df[c].unique().tolist())
        lookups[c] = vals
        m = {v: i for i, v in enumerate(vals)}
        codes[c] = df[c].map(m).astype(int)

    dates = sorted(df["event_date"].unique().tolist())
    date_idx = {d: i for i, d in enumerate(dates)}
    day = df["event_date"].map(date_idx).astype(int)

    users = sorted(df["user_pseudo_id"].astype(str).unique().tolist())
    user_idx = {u: i for i, u in enumerate(users)}
    ucode = df["user_pseudo_id"].astype(str).map(user_idx).astype(int)

    # NaN (purchase with missing revenue) becomes JSON null; the dashboard skips it.
    rev = df["purchase_revenue"].round(2).astype(object).where(df["purchase_revenue"].notna(), None)
    qty = df["total_item_quantity"].astype(int)
    items = df["unique_items"].astype(int)

    col_order = ["day"] + CATEGORICAL_COLS + ["user", "revenue", "qty", "items"]
    arrays = {
        "day": day.tolist(),
        "user": ucode.tolist(),
        "revenue": rev.tolist(),
        "qty": qty.tolist(),
        "items": items.tolist(),
    }
    for c in CATEGORICAL_COLS:
        arrays[c] = codes[c].tolist()

    rows = list(zip(*[arrays[c] for c in col_order]))

    # Descriptive stats block reused by the dashboard's Overview / eCommerce panels
    purchases = df.loc[df["is_purchase_event"]]
    stats = {
        "purchase_revenue": full_stats_block(purchases["purchase_revenue"]),
        "total_item_quantity": full_stats_block(purchases["total_item_quantity"]),
        "unique_items": full_stats_block(purchases["unique_items"]),
        "events_per_user": full_stats_block(df.groupby("user_pseudo_id").size()),
    }

    funnel = {step: int((df["event_name"] == step).sum()) for step in FUNNEL_STEPS}

    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "meta": {
            "n_rows": int(len(df)),
            "n_users": len(users),
            "date_min": dates[0],
            "date_max": dates[-1],
        },
        "cols": col_order,
        "dates": dates,
        "lookups": lookups,
        "rows": rows,
        "stats": stats,
        "funnel": funnel,
    }
    return payload


def main():
    src = find_source()
    print(f"Reading {src}")
    df = load_clean(src)
    write_report(df)
    payload = build_payload(df)
    OUT_JSON.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    size_mb = OUT_JSON.stat().st_size / 1e6
    print(f"Wrote {OUT_JSON} ({size_mb:.2f} MB) and {OUT_REPORT}")
    print(f"Rows: {payload['meta']['n_rows']:,}  Users: {payload['meta']['n_users']:,}  "
          f"Date range: {payload['meta']['date_min']} -> {payload['meta']['date_max']}")


if __name__ == "__main__":
    main()
