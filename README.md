# Pi Web Voice

A fork of [agegr/pi-web](https://github.com/agegr/pi-web) (web UI for the [pi coding agent](https://github.com/badlogic/pi-mono)) that adds **voice dictation**: talk to your agent instead of typing. Audio is transcribed by *your own* self-hosted speech-to-text server — no cloud, no API keys for third parties.

![voice dictation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## What's added

- **🎤 Mic button in the chat composer** — press to record, press again to stop. The transcript is sent to the chat as a prompt automatically (steers a running agent, sends normally when idle).
- **Progressive long-form dictation** — recordings are cut into 60-second segments that transcribe while you keep talking; nothing buffers in memory and transcripts never wait for the end.
- **⌨️ `Shift+A`** toggles the mic outside text fields; **`Cmd/Ctrl+Shift+A`** works anywhere (including the composer).
- **👆 Double-tap** any empty area of the page toggles the mic on touch devices (iOS Safari included).
- **JSON-configurable STT backends** — switch between Parakeet, Qwen3-ASR, Whisper servers, or anything OpenAI-compatible by editing one file. No restart.
- Same-origin `/api/stt` proxy — the STT server needs no CORS setup, and API keys never reach the browser.

Everything else from upstream pi-web is unchanged: sessions, branching, file tools, config panels, i18n (en / zh-CN / zh-TW for all voice strings).

## Install

The package is distributed as a prebuilt tarball — registry installs are not
possible (the npm name is taken) and git-URL installs cannot work (npm's
preparation of git dependencies breaks global installs, and Next.js cannot
build from any path containing `node_modules`, which is where installed
packages live).

From a checkout of this repository:

```bash
scripts/release-tarball.sh          # builds pi-web-voice-<version>.tgz in a scratch worktree
npm install -g pi-web-voice-<version>.tgz
pi-web-voice
```

Requires Node.js 22.19+ and a reachable OpenAI-compatible transcription endpoint (see below). Opens `http://127.0.0.1:30141` by default.

> Updating: re-run the two commands above, or `npm install -g <tarball>` again.

> Installing on another machine: copy the `.tgz` over (AirDrop, scp, a GitHub release attachment) and install it there.

## Configure an STT backend

Create `~/.config/pi-web-voice.json`:

```json
{
  "active": "qwen",
  "backends": {
    "parakeet": {
      "endpoint": "http://192.168.192.1:8816/v1/audio/transcriptions",
      "model": "parakeet-tdt-0.6b-v3"
    },
    "qwen": {
      "endpoint": "http://192.168.192.1:8765/v1/audio/transcriptions",
      "model": "Qwen/Qwen3-ASR-1.7B",
      "apiKey": "your-bearer-token"
    },
    "whisper": {
      "endpoint": "http://localhost:8899/v1/audio/transcriptions",
      "model": "whisper-large-v3-turbo"
    }
  }
}
```

- **`active`** — which backend serves dictation. Switch backends by editing this one field; the file is re-read on every request, no restart.
- **`apiKey`** — optional per-backend Bearer token (e.g. `mlx-qwen3-asr serve` requires one). Stays server-side, never sent to the browser.
- The request's `model` field can also name a backend explicitly (`"model": "parakeet"` routes to the `parakeet` backend).

**Any OpenAI-compatible `/v1/audio/transcriptions` server works.** Good self-hosted options on Apple Silicon:

| Backend | Strengths | One-liner |
|---|---|---|
| [NVIDIA Parakeet TDT 0.6B v3](https://github.com/senstella/parakeet-mlx) via [`parakeet-api`](https://pypi.org/project/parakeet-api/) | Fastest English/European, ~3,300× real-time | `uv tool install parakeet-api && parakeet-api` |
| [Qwen3-ASR 1.7B](https://github.com/moona3k/mlx-qwen3-asr) | Strongest multilingual (30 languages + 22 dialects) | `uv tool install "mlx-qwen3-asr[serve]" && mlx-qwen3-asr serve --api-key <key>` |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server | 99 languages, timestamps, battle-tested | build + `server -m ggml-large-v3-turbo` |

Without a config file, the endpoint falls back to `PI_WEB_STT_ENDPOINT` / `PI_WEB_STT_MODEL` / `PI_WEB_STT_API_KEY` env vars (useful in containers), then to built-in defaults.

## Microphone requirements

- **macOS**: grant your terminal/browser microphone access under System Settings → Privacy & Security.
- **HTTPS or localhost**: browsers only grant microphone access in a secure context. `http://127.0.0.1:30141` works out of the box; for LAN/phone access, put pi-web-voice behind TLS (Cloudflare Tunnel, Tailscale serve, or a local HTTPS proxy) or use SSH port forwarding so the phone sees `127.0.0.1`.
- **iOS**: use Safari; the double-tap gesture replaces the keyboard shortcut.

## Voice config file reference

| Path | Purpose |
|---|---|
| `~/.config/pi-web-voice.json` (or `$PI_WEB_VOICE_CONFIG`) | STT backend routing — `active`, `backends` |

Status/diagnostics: `GET /api/stt` returns the resolved config path, whether the file loaded, the active backend, and the configured backend list.

## Upstream

All upstream pi-web features and docs apply unchanged — see the [upstream README](https://github.com/agegr/pi-web#readme). This fork tracks upstream `v0.9.3`.

## License

MIT — same as upstream.
