# codexhost-bot

Command-line bridge that lets a Grok Bot delegate tasks to [codexhost](https://github.com/BytePioneer-AI/codex-host) devices. It runs on one Linux machine, calls the local `codexhost` CLI directly and remote Macs over SSH, and keeps every credential in a private directory. Output is JSON; credentials never appear in it.

The Bot uses it through the bundled Skill (`skill/SKILL.md`): register the originating Bot, discover devices and projects, start and follow up tasks, export result files and record delivery receipts. Run `codexhost-bot --help` for the full command list.

## Install

Requires Node.js 22.19+ (22.x) or 24.x, `flock`, and codexhost on each execution device.

```sh
npm i -g github:ump45nose/codexhost-bot#<tag>
```

## Configuration

Point `CODEXHOST_BOT_CONFIG` at a private JSON file. All paths must be absolute.

```json
{
  "version": 1,
  "privateDir": "/path/to/private",
  "exportDir": "/path/to/exports",
  "commandPath": "/path/to/bin/codexhost-bot",
  "grok": {
    "version": "0.79.4",
    "controller": "/path/to/grok/controller.js",
    "credentials": "/path/to/grok/credentials.json",
    "machine": "/path/to/grok/machine.json",
    "packageJson": "/path/to/grok/package.json"
  },
  "devices": [
    {
      "id": "local",
      "transport": "local",
      "cli": "/path/to/bin/codexhost",
      "node": "/path/to/bin/node",
      "dataDir": "/path/to/codexhost-data",
      "privateDir": "/path/to/device-private"
    },
    {
      "id": "mac",
      "transport": "ssh",
      "ssh": { "destination": "user@host", "identityFile": "/path/to/ssh/key" },
      "cli": "/path/to/bin/codexhost",
      "node": "/path/to/bin/node",
      "dataDir": "/path/to/codexhost-data",
      "privateDir": "/path/to/device-private"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `privateDir` | Origin bindings, client tokens and task records (mode 0700). |
| `exportDir` | Where exported result files are written for the Bot to send. |
| `commandPath` | Installed `codexhost-bot` path quoted into the Bot routine prompt. |
| `grok.*` | Installed Grok Bot files; only version 0.79.4 is supported and its `package.json` must match. |
| `devices[].id` | Unique lowercase device name used by `--device`. |
| `devices[].transport` | `local`, or `ssh` with `ssh.destination` (`user@host`) and `ssh.identityFile`. |
| `devices[].cli`, `node` | codexhost CLI and Node.js paths on that device. |
| `devices[].dataDir` | codexhost data directory on that device. |
| `devices[].privateDir` | Directory on that device that receives the client token file. |

Each device gets its own codexhost client, registered once with `codexhost client add <name>`.

## systemd

`systemd/codexhost-bot.service` runs the resident listener as a user service:

```sh
cp systemd/codexhost-bot.service ~/.config/systemd/user/
mkdir -p ~/.config/codexhost-bot
# ~/.config/codexhost-bot/env: PATH, CODEXHOST_BOT_CONFIG and any proxy variables
systemctl --user enable --now codexhost-bot
```

## Development

```sh
npm install
npm test
```

## License

LGPL-3.0-only. Derived from codexhost.
