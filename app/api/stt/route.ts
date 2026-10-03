import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * STT proxy — forwards a recorded audio blob to a self-hosted,
 * OpenAI-compatible transcription endpoint and returns its JSON response.
 *
 * Why a proxy instead of the browser calling the STT server directly:
 * 1. No CORS surface — the STT server needs no configuration, and the
 *    browser only ever talks same-origin.
 * 2. The endpoint/model live in server env, not in client code.
 *
 * Configuration (optional, with fallbacks):
 *   PI_WEB_STT_ENDPOINT — full transcriptions URL
 *                         (default http://192.168.192.1:8816/v1/audio/transcriptions)
 *   PI_WEB_STT_MODEL    — model id (default parakeet-tdt-0.6b-v3)
 *   PI_WEB_STT_API_KEY  — optional Bearer token for the STT server
 *                         (e.g. mlx-qwen3-asr serve requires one)
 *
 * Accepts multipart/form-data with an `file` part (any audio format the
 * upstream can decode via ffmpeg: webm/opus, mp4/aac, wav, m4a…).
 */

const DEFAULT_ENDPOINT = "http://192.168.192.1:8816/v1/audio/transcriptions";
const DEFAULT_MODEL = "parakeet-tdt-0.6b-v3";

// Long dictations plus slow upstream models still fit comfortably; this
// guards a hung server, not a long recording.
const UPSTREAM_TIMEOUT_MS = 120_000;

export async function POST(request: Request) {
  const endpoint = process.env.PI_WEB_STT_ENDPOINT || DEFAULT_ENDPOINT;
  const model = process.env.PI_WEB_STT_MODEL || DEFAULT_MODEL;

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "invalid-form" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "file-required" }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.append("file", file, file.name || "audio.webm");
  outgoing.append("model", model);

  const upstreamHeaders: Record<string, string> = {};
  if (process.env.PI_WEB_STT_API_KEY) {
    upstreamHeaders.authorization = `Bearer ${process.env.PI_WEB_STT_API_KEY}`;
  }

  try {
    const upstream = await fetch(endpoint, {
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
