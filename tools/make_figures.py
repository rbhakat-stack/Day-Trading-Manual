"""Generate the explanatory diagrams used in the manual.

All figures are schematic illustrations drawn from synthetic data. They are NOT
screenshots of TrendSpider, SignalStack or Alpaca and must never be presented as such.

Run:  python tools/make_figures.py
Output: manual/figures/*.png
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, Rectangle

OUT = Path(__file__).resolve().parent.parent / "manual" / "figures"
OUT.mkdir(parents=True, exist_ok=True)

GREEN = "#1a9e5a"
RED = "#d64545"
BLUE = "#2f6fdb"
ORANGE = "#e08a1e"
PURPLE = "#7b4fd1"
GREY = "#666666"

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})


def save(fig, name):
    fig.savefig(OUT / name, dpi=170, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def candle(ax, x, o, h, l, c, w=0.6, color=None):
    color = color or (GREEN if c >= o else RED)
    ax.plot([x, x], [l, h], color=color, lw=1.6, zorder=1)
    body_lo, body_hi = min(o, c), max(o, c)
    if body_hi - body_lo < 1e-9:
        ax.plot([x - w / 2, x + w / 2], [o, o], color=color, lw=2.2, zorder=2)
    else:
        ax.add_patch(Rectangle((x - w / 2, body_lo), w, body_hi - body_lo,
                               facecolor=color, edgecolor=color, zorder=2))


# ---------------------------------------------------------------- 1. anatomy
def fig_anatomy():
    fig, ax = plt.subplots(figsize=(8, 5))
    candle(ax, 1, 100.0, 101.6, 99.4, 101.0)
    candle(ax, 3.2, 101.0, 101.6, 99.4, 100.0)
    for x, (o, h, l, c), title in [(1, (100.0, 101.6, 99.4, 101.0), "BULLISH (Close > Open)"),
                                   (3.2, (101.0, 101.6, 99.4, 100.0), "BEARISH (Close < Open)")]:
        ax.text(x, 102.15, title, ha="center", fontweight="bold")
        ax.annotate(f"High {h:.2f}", (x, h), (x + 0.55, h), va="center", arrowprops=dict(arrowstyle="-", color=GREY))
        ax.annotate(f"Low {l:.2f}", (x, l), (x + 0.55, l), va="center", arrowprops=dict(arrowstyle="-", color=GREY))
        top, bot = max(o, c), min(o, c)
        lab_top = "Close" if c > o else "Open"
        lab_bot = "Open" if c > o else "Close"
        ax.annotate(f"{lab_top} {top:.2f}", (x + 0.3, top), (x + 0.55, top + 0.12), va="center",
                    arrowprops=dict(arrowstyle="-", color=GREY))
        ax.annotate(f"{lab_bot} {bot:.2f}", (x + 0.3, bot), (x + 0.55, bot - 0.12), va="center",
                    arrowprops=dict(arrowstyle="-", color=GREY))
        ax.text(x - 0.45, (h + top) / 2, "upper\nwick", ha="right", va="center", fontsize=8, color=GREY)
        ax.text(x - 0.45, (top + bot) / 2, "body", ha="right", va="center", fontsize=8, color=GREY)
        ax.text(x - 0.45, (bot + l) / 2, "lower\nwick", ha="right", va="center", fontsize=8, color=GREY)
    ax.text(2.1, 98.95, "Range = High - Low = 101.60 - 99.40 = $2.20 for both candles", ha="center", fontsize=9)
    ax.set_xlim(-0.3, 4.6)
    ax.set_ylim(98.7, 102.5)
    ax.set_xticks([])
    ax.set_ylabel("Price ($)")
    ax.set_title("Figure 2-1  Candle anatomy (schematic)", loc="left", fontsize=11)
    save(fig, "fig-02-1-candle-anatomy.png")


# ---------------------------------------------------------------- 2. patterns
def fig_patterns():
    pats = [
        ("Strong bullish", [(10, 13.9, 9.9, 13.8)]),
        ("Strong bearish", [(13.8, 13.9, 9.9, 10.0)]),
        ("Doji", [(11.9, 13.5, 10.5, 12.0)]),
        ("Hammer", [(12.6, 13.1, 9.6, 13.0)]),
        ("Inverted hammer", [(10.4, 13.5, 10.0, 10.9)]),
        ("Shooting star", [(13.0, 15.5, 12.7, 12.6)]),
        ("Long lower wick", [(12.2, 12.8, 9.5, 12.5)]),
        ("Long upper wick", [(11.5, 14.6, 11.2, 11.8)]),
        ("Bullish engulfing", [(12.5, 12.7, 11.3, 11.5), (11.3, 13.2, 11.1, 13.0)]),
        ("Bearish engulfing", [(11.5, 12.7, 11.3, 12.5), (12.8, 13.0, 10.8, 11.1)]),
        ("Inside bar", [(10.2, 14.0, 9.8, 13.6), (12.6, 13.4, 11.2, 11.9)]),
        ("Breakout candle", [(11.5, 12.0, 11.0, 11.8), (11.8, 12.1, 11.3, 11.6), (11.7, 14.1, 11.6, 14.0)]),
        ("Rejection candle", [(11.0, 12.0, 10.8, 11.9), (11.9, 14.5, 11.7, 12.0)]),
    ]
    fig, axes = plt.subplots(3, 5, figsize=(13, 8))
    for ax in axes.flat:
        ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values():
            s.set_color("#cccccc")
    for ax, (name, cs) in zip(axes.flat, pats):
        for i, (o, h, l, c) in enumerate(cs):
            candle(ax, i, o, h, l, c, w=0.55)
        ax.set_xlim(-0.8, max(2, len(cs)) - 0.2)
        ax.set_ylim(9, 16)
        ax.set_title(name, fontsize=10)
        if name == "Breakout candle":
            ax.axhline(12.15, color=BLUE, ls="--", lw=1)
            ax.text(-0.7, 12.3, "resistance", fontsize=7, color=BLUE)
        if name == "Rejection candle":
            ax.axhline(13.0, color=BLUE, ls="--", lw=1)
            ax.text(-0.7, 13.15, "resistance", fontsize=7, color=BLUE)
    for ax in axes.flat[len(pats):]:
        ax.axis("off")
    axes.flat[-1].text(0.0, 0.5, "Green = bullish (close > open)\nRed = bearish (close < open)\n\n"
                       "Shapes are idealised.\nReal candles are messier.\nContext decides meaning.",
                       fontsize=9, va="center")
    fig.suptitle("Figure 2-3  Common candle forms (schematic)", x=0.01, ha="left", fontsize=12)
    fig.tight_layout()
    save(fig, "fig-02-3-candle-patterns.png")


# ---------------------------------------------------------------- 3. long vs short
def fig_long_short():
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    prices = np.linspace(95, 105, 50)
    shares = 100
    for ax, side in zip(axes, ["LONG 100 shares @ $100", "SHORT 100 shares @ $100"]):
        pnl = (prices - 100) * shares if side.startswith("LONG") else (100 - prices) * shares
        ax.plot(prices, pnl, color=BLUE, lw=2)
        ax.fill_between(prices, pnl, 0, where=pnl >= 0, color=GREEN, alpha=0.2)
        ax.fill_between(prices, pnl, 0, where=pnl < 0, color=RED, alpha=0.2)
        ax.axhline(0, color="black", lw=0.8)
        ax.axvline(100, color=GREY, ls=":")
        ax.set_title(side, fontweight="bold")
        ax.set_xlabel("Price when you exit ($)")
        ax.grid(alpha=0.3)
        for px in (98, 103):
            v = (px - 100) * shares if side.startswith("LONG") else (100 - px) * shares
            ax.plot(px, v, "o", color="black")
            ax.annotate(f"exit ${px}: {'+' if v > 0 else ''}{v:,.0f}", (px, v), (px + 0.3, v + (60 if v > 0 else -90)), fontsize=9)
    axes[0].set_ylabel("Profit / loss ($)")
    fig.suptitle("Figure 1-2  Long profits when price rises; short profits when price falls", x=0.01, ha="left")
    fig.tight_layout()
    save(fig, "fig-01-2-long-vs-short.png")


# ---------------------------------------------------------------- 4. R ladder
def fig_r_ladder():
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.6))
    for ax, side in zip(axes, ["LONG", "SHORT"]):
        entry, risk = 100.0, 0.50
        sgn = 1 if side == "LONG" else -1
        levels = [("Stop  (-1R)", entry - sgn * risk, RED), ("Entry (0R)", entry, "black"),
                  ("+1R", entry + sgn * risk, GREY), ("Target +2R", entry + sgn * 2 * risk, GREEN)]
        for name, y, col in levels:
            ax.axhline(y, color=col, lw=2 if "R)" in name or "Target" in name else 1.2)
            ax.text(1.02, y, f"{name}: ${y:.2f}", va="center", transform=ax.get_yaxis_transform(), fontsize=9, color=col)
        lo, hi = sorted([entry - sgn * risk, entry + sgn * 2 * risk])
        ax.axhspan(min(entry, entry - sgn * risk), max(entry, entry - sgn * risk), color=RED, alpha=0.12)
        ax.axhspan(min(entry, entry + sgn * 2 * risk), max(entry, entry + sgn * 2 * risk), color=GREEN, alpha=0.12)
        ax.set_ylim(lo - 0.3, hi + 0.3)
        ax.set_xticks([])
        ax.set_title(f"{side}: entry $100.00, risk $0.50/share", fontweight="bold")
    fig.suptitle("Figure 19-1  R-multiple ladder (1R = risk per share)", x=0.01, ha="left")
    fig.tight_layout()
    save(fig, "fig-19-1-r-ladder.png")


# ---------------------------------------------------------------- 5. expectancy
def fig_breakeven():
    fig, ax = plt.subplots(figsize=(8, 4.2))
    r = np.linspace(0.5, 4, 100)
    ax.plot(r, 100 / (1 + r), color=BLUE, lw=2)
    for rr in (1, 1.5, 2, 3):
        be = 100 / (1 + rr)
        ax.plot(rr, be, "o", color="black")
        ax.annotate(f"{rr:g}R target -> need > {be:.1f}% wins", (rr, be), (rr + 0.12, be + 3), fontsize=9)
    ax.set_xlabel("Average winner in R (average loser = 1R)")
    ax.set_ylabel("Break-even win rate (%)")
    ax.grid(alpha=0.3)
    ax.set_title("Figure 19-2  Break-even win rate = 1 / (1 + payoff ratio)  (before costs)", loc="left", fontsize=11)
    save(fig, "fig-19-2-breakeven.png")


# ---------------------------------------------------------------- 6. synthetic intraday chart
def fig_intraday():
    rng = np.random.default_rng(7)
    n = 78  # 5-minute bars in a 6.5h session
    drift = np.concatenate([np.full(20, 0.02), np.full(30, 0.06), np.full(28, -0.01)])
    closes = 100 + np.cumsum(drift + rng.normal(0, 0.12, n))
    opens = np.concatenate([[100], closes[:-1]])
    highs = np.maximum(opens, closes) + rng.uniform(0.02, 0.15, n)
    lows = np.minimum(opens, closes) - rng.uniform(0.02, 0.15, n)
    vol = rng.integers(40_000, 120_000, n).astype(float)
    vol[:6] *= 2.5
    vol[20:24] *= 2.2
    tp = (highs + lows + closes) / 3
    vwap = np.cumsum(tp * vol) / np.cumsum(vol)

    def ema(x, n):
        a, out = 2 / (n + 1), [x[0]]
        for v in x[1:]:
            out.append(a * v + (1 - a) * out[-1])
        return np.array(out)

    e9, e20 = ema(closes, 9), ema(closes, 20)
    fig, (ax, axv) = plt.subplots(2, 1, figsize=(12, 6.2), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    for i in range(n):
        candle(ax, i, opens[i], highs[i], lows[i], closes[i], w=0.6)
    ax.plot(vwap, color=PURPLE, lw=2, label="Session VWAP (HLC3)")
    ax.plot(e9, color=ORANGE, lw=1.4, label="EMA9")
    ax.plot(e20, color=BLUE, lw=1.4, label="EMA20")
    ax.legend(loc="upper left")
    ax.set_ylabel("Price ($)")
    ax.annotate("Price reclaims VWAP,\nEMA9 crosses above EMA20", (22, closes[22]), (8, closes.max() - 0.2),
                arrowprops=dict(arrowstyle="->"), fontsize=9)
    ax.annotate("Pullback to VWAP / EMA20", (int(np.argmin(np.abs(closes[35:60] - vwap[35:60]))) + 35, vwap[45]),
                (40, closes.min() + 0.1), arrowprops=dict(arrowstyle="->"), fontsize=9)
    axv.bar(range(n), vol, color=[GREEN if c >= o else RED for o, c in zip(opens, closes)])
    axv.plot(np.convolve(vol, np.ones(20) / 20, mode="full")[:n], color="black", lw=1, label="Volume MA20 (approx.)")
    axv.set_ylabel("Volume")
    axv.set_xlabel("5-minute bar number (bar 0 = 9:30-9:35 ET)")
    axv.legend(loc="upper right", fontsize=8)
    ax.set_title("Figure 3-1  Synthetic 5-minute session with VWAP, EMA9, EMA20 and volume (illustration only)", loc="left")
    fig.tight_layout()
    save(fig, "fig-03-1-intraday-vwap-ema.png")


# ---------------------------------------------------------------- 7. boxes helper + flows
def box(ax, x, y, w, h, text, fc="#eef3fb", ec=BLUE, fs=9, bold=False):
    ax.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0.02",
                                facecolor=fc, edgecolor=ec, lw=1.4))
    ax.text(x, y, text, ha="center", va="center", fontsize=fs, fontweight="bold" if bold else "normal", wrap=True)


def arrow(ax, x1, y1, x2, y2, text=None):
    ax.annotate("", (x2, y2), (x1, y1), arrowprops=dict(arrowstyle="-|>", color="black", lw=1.2))
    if text:
        ax.text((x1 + x2) / 2 + 0.05, (y1 + y2) / 2, text, fontsize=8, color=GREY, va="center")


def fig_architecture():
    fig, ax = plt.subplots(figsize=(8.5, 9))
    ax.axis("off")
    ax.set_xlim(0, 10); ax.set_ylim(0, 12)
    steps = [
        ("TrendSpider Multi-Factor Alert fires\n(analysis + scanner + alerts)", "#eef3fb", BLUE),
        ("YOU review the chart\n(checklist, entry, stop, size, 2R target)", "#fff6e5", ORANGE),
        ("TrendSpider Trading widget\n(manual order ticket - you press Submit)", "#eef3fb", BLUE),
        ("SignalStack\n(order router between TrendSpider and broker)", "#f2ecfb", PURPLE),
        ("Alpaca PAPER account\n(simulated brokerage - no real money)", "#e9f7ef", GREEN),
        ("Paper position, fills and P/L\n(record in your trade journal)", "#e9f7ef", GREEN),
    ]
    ys = np.linspace(11, 1.2, len(steps))
    for (t, fc, ec), y in zip(steps, ys):
        box(ax, 5, y, 7.2, 1.25, t, fc=fc, ec=ec, fs=10)
    for y1, y2 in zip(ys[:-1], ys[1:]):
        arrow(ax, 5, y1 - 0.66, 5, y2 + 0.66)
    ax.text(0.1, 11.9, "Figure 32-1  v1 paper-trading architecture (manual, human-in-the-loop)", fontsize=11)
    ax.text(9.9, ys[1], "HUMAN\nDECISION", ha="right", va="center", fontsize=8, color=ORANGE, fontweight="bold")
    save(fig, "fig-32-1-architecture.png")


def fig_flow(side):
    L = side == "LONG"
    fig, ax = plt.subplots(figsize=(9, 13))
    ax.axis("off"); ax.set_xlim(0, 11.6); ax.set_ylim(0, 20)
    steps = [
        f"{side} alert fires (RB v1 - {side} Setup)",
        "Open ticker. Alert 09:45 to before 15:30 ET?\n(signal candle = the 5m candle that just CLOSED)",
        f"HARD RULES (calculator): {'green (C > O)' if L else 'red (C < O)'} candle | last completed\n15m close {'>' if L else '<'} EMA20 | not stale (10 min) | not chased (0.25 ATR)",
        "Do-Not-Take checklist: candle size, extension,\nspread, news/earnings, S/R ahead, regime",
        f"E = signal {'HIGH + B' if L else 'LOW - B'},  B = max($0.01, 0.02% x {'High' if L else 'Low'})\nR = max({'E - Low' if L else 'High - E'}, 1 x ATR)    Stop = E {'-' if L else '+'} R",
        "Shares = min(floor(\\$250 / R), floor(\\$20,000 / E))\nOpportunity Ranker: score >= 85 and capital -> TRADE NOW",
        f"Target = E {'+' if L else '-'} 2R",
        "Paper order in Trading widget (Alpaca PAPER selected)\nconfirm side, qty, stop, target BEFORE Submit",
        "Did price trade the trigger within 10 minutes of the alert?",
        "Manage: stop | 2R target | trend failure | time stop (~6 candles, < +0.5R)\nRecord the trade in the journal",
    ]
    ys = np.linspace(19, 1, len(steps))
    for i, (t, y) in enumerate(zip(steps, ys)):
        fc = "#fff6e5" if i in (3, 8) else ("#e9f7ef" if L else "#fdecec")
        box(ax, 5, y, 8.4, 1.45, f"{i + 1}. {t}", fc=fc, ec=GREEN if L else RED, fs=9)
    for y1, y2 in zip(ys[:-1], ys[1:]):
        arrow(ax, 5, y1 - 0.76, 5, y2 + 0.76)
    ax.text(9.95, ys[1], "no -> SKIP", ha="right", fontsize=8, color=RED)
    ax.text(9.95, ys[2] + 0.9, "any fail -> NOT\nELIGIBLE", ha="right", fontsize=8, color=RED)
    ax.text(9.95, ys[3] + 0.9, "any red flag\n-> SKIP", ha="right", fontsize=8, color=RED)
    ax.text(9.95, ys[8] + 0.9, "no -> CANCEL,\nno chasing", ha="right", fontsize=8, color=RED)
    ax.text(0.05, 19.95, f"Figure 36-{1 if L else 2}  {side} execution flowchart (v1.1)", fontsize=11)
    save(fig, f"fig-36-{1 if L else 2}-flow-{side.lower()}.png")


def fig_mtf():
    fig, axes = plt.subplots(1, 3, figsize=(13, 3.8))
    x = np.arange(40)
    cases = [
        ("ALIGNED: 15m up, 5m up -> valid LONG context", 0.05, 0.05),
        ("CONFLICT: 15m down, 5m bounce -> dangerous LONG", -0.06, 0.08),
        ("ALIGNED: 15m down, 5m down -> valid SHORT context", -0.05, -0.05),
    ]
    for ax, (t, slope15, slope5) in zip(axes, cases):
        y15 = 100 + slope15 * x
        y5 = y15 + np.where(x > 28, slope5 * (x - 28) * 2.2, 0) + 0.15 * np.sin(x / 2)
        ax.plot(x, y15, color=BLUE, lw=3, alpha=0.5, label="15m trend (EMA20)")
        ax.plot(x, y5, color=ORANGE, lw=1.5, label="5m price")
        ax.axvspan(28, 39, color="#ffeeba", alpha=0.5)
        ax.set_title(t, fontsize=9)
        ax.set_xticks([]); ax.set_yticks([])
    axes[0].legend(fontsize=8, loc="upper left")
    fig.suptitle("Figure 9-1  Multi-timeframe alignment vs conflict (shaded = the 5m signal area)", x=0.01, ha="left")
    fig.tight_layout()
    save(fig, "fig-09-1-mtf.png")


if __name__ == "__main__":
    fig_anatomy(); fig_patterns(); fig_long_short(); fig_r_ladder(); fig_breakeven()
    fig_intraday(); fig_architecture(); fig_flow("LONG"); fig_flow("SHORT"); fig_mtf()
    print("figures written to", OUT)
