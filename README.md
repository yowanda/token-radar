# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yowanda/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yowanda/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones still record no token and are not a wrapped, staked or bridged product of one that trades, and ranks them by what their launch would be worth. It hands in a web dashboard with the ranked board, a detail view for every protocol with the model's own line-by-line breakdown, and a concrete farm plan — what to do, what it costs, how long it takes — for each one.

The value model is priced from the snapshot itself: each category's comp is the median market-cap-to-TVL ratio of the live-token protocols in that category, combined with the protocol's TVL, its seven-day growth, and how long it has run with no token on record. No protocol name is special-cased. The board covers all 40 watchlist protocols plus 138 pre-token protocols below the watchlist floor; 24 live-token protocols are set aside in their own view with their market caps shown, never mixed into the ranking.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only — nothing to install. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
