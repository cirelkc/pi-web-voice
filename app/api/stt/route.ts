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
 *   PI_WEB_STT_CLEANUP  — "on" (default) | "off": post-process the transcript
 *                         through a local LLM to strip fillers/false starts
 *   PI_WEB_LLM_BASE_URL — OpenAI-compatible chat endpoint base
 *                         (default http://192.168.192.1:8080/v1)
 *   PI_WEB_LLM_MODEL    — cleanup model (default glm-5.3-flash)
 *   PI_WEB_LLM_API_KEY  — bearer token (default "local-8080")
 *
 * Accepts multipart/form-data with an `file` part (any audio format the
 * upstream can decode via ffmpeg: webm/opus, mp4/aac, wav, m4a…).
 */

const DEFAULT_ENDPOINT = "http://192.168.192.1:8816/v1/audio/transcriptions";
const DEFAULT_MODEL = "parakeet-tdt-0.6b-v3";
const DEFAULT_LLM_BASE_URL = "http://192.168.192.1:8080/v1";
const DEFAULT_LLM_MODEL = "glm-5.3-flash";
const DEFAULT_LLM_API_KEY = "local-8080";

// Long dictations plus slow upstream models still fit comfortably; this
// guards a hung server, not a long recording.
const UPSTREAM_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 90_000;

const CLEANUP_SYSTEM_PROMPT = [
  "You clean up raw speech-to-text transcripts.",
  "Remove filler words (um, uh), false starts, and self-corrections — keep only the corrected statement.",
  "Fix punctuation and capitalization.",
  "Do NOT change wording, names, numbers, or meaning otherwise. Do not add information.",
  "If a passage is unintelligible, leave it unchanged rather than guessing.",
  "Return only the cleaned text, no commentary.",
].join(" ");

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

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      body: outgoing,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `upstream-${upstream.status}`, detail: body.slice(0, 300) },
        { status: 502 },
      );
    }

    // Disfluency cleanup through the local LLM. Best-effort: any failure in
    // the cleanup path returns the raw STT text — a cleanup outage must
    // never turn a working dictation into an error.
    let text: string | undefined;
    try {
      text = (JSON.parse(body) as { text?: string }).text;
    } catch {
      // Non-JSON upstream body — pass it through untouched below.
    }
    if (typeof text === "string" && text.trim() && process.env.PI_WEB_STT_CLEANUP !== "off") {
      const cleaned = await cleanupTranscript(text);
      if (cleaned !== null) {
        return NextResponse.json({ text: cleaned, cleaned: true });
      }
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

/** Returns cleaned text, or null when cleanup is unavailable/failed (caller falls back to raw). */
async function cleanupTranscript(text: string): Promise<string | null> {
  try {
    const baseUrl = (process.env.PI_WEB_LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.PI_WEB_LLM_API_KEY || DEFAULT_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.PI_WEB_LLM_MODEL || DEFAULT_LLM_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: CLEANUP_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    // Empty cleanup (model refused / returned nothing) → keep the raw text.
    return cleaned ? cleaned : null;
  } catch {
    return null;
  }
}
