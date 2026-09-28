# dsh-notify

Port of [pi-notify](https://github.com/xz-dev/pi-notify) plus the local `ask-user-semantic-hook` and `herdr-agent-state` extensions onto DeepSeek Harness. Behaviour matrix: [BEHAVIOR.md](./BEHAVIOR.md).

Config: `$DSH_HOME/dsh-notify.json` (or `configPath`), same JSON shape as pi-notify: `events` and `hooks` with `bel`, `osc`, `osc:title|body`, `cmd:`, `shell:` tuples, and `js:` actions. A missing file means no bindings. Actions receive `PI_NOTIFY_*` environment variables (pi-notify's contract, kept so existing delivery scripts work).

`enableHerdr` (default `false`) reports working/blocked/idle to a herdr pane. Leave it off when herdr's own agent integration is active; both together duplicate state.

```bash
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tui add file:/absolute/path/dsh-notify-0.2.0.tgz --ignore-scripts
```

The package `cordis.patch.yml` inserts plugin id `dsh-notify`. Herdr wire identity stays `herdr:pi` / `agent=pi` so existing pane metadata still matches.

Licence: MIT, same as pi-notify, Copyright (c) 2026 xz-dev.
