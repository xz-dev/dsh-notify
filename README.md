# dsh-notify

Port of [pi-notify](https://github.com/xz-dev/pi-notify) plus the local `ask-user-semantic-hook` and `herdr-agent-state` extensions onto DeepSeek Harness. Behaviour matrix: [BEHAVIOR.md](./BEHAVIOR.md).

Same JSON as `~/.pi/agent/pi-notify.json`: `events` and `hooks` with `bel`, `osc`, `osc:title|body`, `cmd:`, `shell:` tuples, and `js:` actions. With no `configPath` and no `$DSH_HOME/dsh-notify.json`, the plugin reads `~/.pi/agent/pi-notify.json` (the `cmd:` lines keep calling `~/.pi/agent/pi-notify-delivery.mjs`).

```bash
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tui add file:/absolute/path/dsh-notify-0.1.0.tgz --ignore-scripts
```

The package `cordis.patch.yml` inserts plugin id `dsh-notify`. Herdr wire identity stays `herdr:pi` / `agent=pi` so existing pane metadata still matches.

Licence: MIT, same as pi-notify, Copyright (c) 2026 xz-dev.
