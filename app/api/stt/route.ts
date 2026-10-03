import { NextResponse } from "next/server";
import { loadVoiceFileConfig, resolveSttBackend, voiceConfigPath } from "@/lib/voice-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * STT proxy — forwards a recorded audio blob to a self-hosted,
 * OpenAI-compatible transcription endpoint and returns its JSON response.
 *
 * Why a proxy instead of the browser calling the STT server directly:
 * 1. No CORS surface — the STT server needs no configuration, and the
 *    browser only ever talks same-origin.
 * 2. Backend selection, model ids, and keys live server-side.
 *
 * Backend selection comes from the JSON voice config (see lib/voice-config.ts):
 *   ~/.config/pi-web-voice.json (or $PI_WEB_VOICE_CONFIG)
 *     {
 *       "active": "qwen",
 *       "backends": {
 *         "parakeet": { "endpoint": "...", "model": "..." },
 *         "qwen":     { "endpoint": "...", "model": "...", "apiKey": "..." }
 *       }
 *     }
 * Switching backends = editing the file (re-read every request, no restart).
 * Without a config file, PI_WEB_STT_* env vars apply, then built-in defaults.
 *
 * A request's `model` field (multipart part or ?model= query) either names a
 * configured backend (routing) or is passed through as a raw model id.
 *
 * Accepts multipart/form-data with an `file` part (any audio format the
 * upstream can decode via ffmpeg: webm/opus, mp4/aac, wav, m4a…).
 */

// Long dictations plus slow upstream models still fit comfortably; this
// guards a hung server, not a long recording.
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Config summary for clients/debugging — which backends exist and which is active. */
export async function GET() {
  const config = loadVoiceFileConfig();
  return NextResponse.json({
    configPath: voiceConfigPath(),
    configLoaded: config !== null,
    active: config?.active ?? "env",
    backends: Object.entries(config?.backends ?? {}).map(([name, settings]) => ({
      name,
      endpoint: settings.endpoint,
      model: settings.model ?? null,
      hasApiKey: Boolean(settings.apiKey),
    })),
  });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid-form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "file-required" }, { status: 400 });
  }

  // Route by model field: a configured backend name selects that backend;
  // anything else passes through as a raw model id to the resolved backend.
  const queryModel = new URL(request.url).searchParams.get("model");
  const formModelRaw = form.get("model");
  const requested = (typeof formModelRaw === "string" && formModelRaw.trim()) || queryModel || null;
  const backend = resolveSttBackend(requested);
  const isBackendName = Boolean(loadVoiceFileConfig()?.backends?.[requested ?? ""]);
  const model = isBackendName ? backend.model : (requested ?? backend.model);

  const outgoing = new FormData();
  outgoing.append("file", file, file.name || "audio.webm");
  if (model) outgoing.append("model", model);

  const upstreamHeaders: Record<string, string> = {};
  if (backend.apiKey) {
    upstreamHeaders.authorization = `Bearer ${backend.apiKey}`;
  }

  try {
    const upstream = await fetch(backend.endpoint, {
      method: "POST",
      body: outgoing,
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `upstream-${upstream.status}`, detail: body.slice(0, 300) },
        { status: 502 },
      );
    }

    // Pass the upstream JSON through verbatim ({ text: "…" }).
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "upstream-unreachable", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
