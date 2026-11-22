# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mhmmdzildan03/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mhmmdzildan03/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch as a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON edit objects (detected automatically, or chosen with `--format`), finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, then indentation-insensitive with re-indenting), and writes every change or none, printing what it changed or why it failed. Node 22, standard library only; `SPEC.md` is the full specification it implements.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=n8m845w8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
