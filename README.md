# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yowanda/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yowanda/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones still record no token, and ranks them by what their launch would be worth. It hands in a web dashboard with the ranked board, a detail view for every protocol with the model's own line-by-line breakdown, and a concrete farm plan — what to do, what it costs, how long it takes — for each one.

The value model is fitted from the snapshot itself, in two halves chosen by honest out-of-sample validation (repeated 10×5-fold cross-validation, every candidate reported on the page): log(market cap) is regressed on log(TVL), seven-day growth and uncapped age by Huber robust regression on the 128 protocols whose token already trades (repeated-CV R² 0.156, up from the round-2 OLS base at 0.151 — the gains are small and the page says so), then multiplied by P(token) from a logistic regression on the snapshot's own figures, fitted on all 758 protocols (repeated-CV log-loss 0.600, against 0.647 for the round-2 9-cell rates and 0.688 for the global rate). No protocol name is special-cased. Every row carries an 80% interval from the fit's residual spread, and the dashboard adds a distribution histogram, a fitted-vs-actual calibration scatter, and a head-to-head comparison of any three of the top 60 protocols. The board covers all 342 pre-token protocols (all 40 watchlist protocols plus every other pre-token protocol in the snapshot); all 128 live-token protocols are set aside in their own view with their market caps shown, never mixed into the ranking; the 288 protocols whose token already trades but whose market cap the snapshot does not record as a positive number sit in a third view of their own.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only — nothing to install. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vpa00rt3&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
