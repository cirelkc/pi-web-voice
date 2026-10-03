import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * voice-config — server-side JSON configuration for the voice dictation
 * pipeline (which STT backend to use, and which backends are available).
 *
 * File location (first match):
 *   1. $PI_WEB_VOICE_CONFIG
 *   2. ~/.config/pi-web-voice.json
 *
 * Shape:
 * {
 *   "active": "qwen",
 *   "backends": {
 *     "parakeet": { "endpoint": "http://192.168.192.1:8816/v1/audio/transcriptions",
 *                   "model": "parakeet-tdt-0.6b-v3" },
 *     "qwen":     { "endpoint": "http://192.168.192.1:8765/v1/audio/transcriptions",
 *                   "model": "Qwen/Qwen3-ASR-1.7B",
 *                   "apiKey": "..." }
 *   }
 * }
 *
 * Resolution order for a transcription request:
 *   1. Config file — request `model` naming a configured backend selects it,
 *      otherwise `active` is used. The file is re-read on every request
 *      (mtime-checked), so switching backends is an edit, not a restart.
 *   2. Environment — PI_WEB_STT_ENDPOINT / PI_WEB_STT_MODEL / PI_WEB_STT_API_KEY
 *      (kept for backward compatibility and container deployments).
 *   3. Built-in defaults.
 *
 * A malformed config file must never break dictation: parse failures fall
 * through to the next resolution step.
 */

export interface SttBackendSettings {
  endpoint: string;
  model?: string;
  apiKey?: string;
}

export interface VoiceFileConfig {
  active?: string;
  backends?: Record<string, SttBackendSettings>;
}

export interface ResolvedSttBackend {
  endpoint: string;
  model?: string;
  apiKey?: string;
  /** Backend name from the config file, or "env"/"default" for diagnostics. */
  source: string;
}

const DEFAULT_ENDPOINT = "http://192.168.192.1:8816/v1/audio/transcriptions";
const DEFAULT_MODEL = "parakeet-tdt-0.6b-v3";

let mtimeCache: { path: string; mtime: number; config: VoiceFileConfig | null } | null = null;

export function voiceConfigPath(): string {
  return process.env.PI_WEB_VOICE_CONFIG || join(homedir(), ".config", "pi-web-voice.json");
}

/** Loads the JSON config, mtime-cached so backend switches need no restart. */
export function loadVoiceFileConfig(): VoiceFileConfig | null {
  const path = voiceConfigPath();
  if (!existsSync(path)) return null;
  try {
    const mtime = statSync(path).mtimeMs;
    if (mtimeCache && mtimeCache.path === path && mtimeCache.mtime === mtime) {
      return mtimeCache.config;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VoiceFileConfig;
    mtimeCache = { path, mtime, config: parsed };
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve which backend serves this request. `requestedModel` is the model
 * field from the OpenAI-compatible request; when it names a configured
 * backend, that backend is selected explicitly.
 */
export function resolveSttBackend(requestedModel?: string | null): ResolvedSttBackend {
  const config = loadVoiceFileConfig();
  if (config?.backends) {
    const backends = config.backends;
    const byName =
      (requestedModel && backends[requestedModel] && { name: requestedModel, settings: backends[requestedModel] })
      || (config.active && backends[config.active] && { name: config.active, settings: backends[config.active] });
    if (byName && byName.settings.endpoint) {
      return {
        endpoint: byName.settings.endpoint,
        model: byName.settings.model ?? (byName.name === requestedModel ? undefined : requestedModel ?? undefined),
        apiKey: byName.settings.apiKey || undefined,
        source: byName.name,
      };
    }
  }

  return {
    endpoint: process.env.PI_WEB_STT_ENDPOINT || DEFAULT_ENDPOINT,
    model: process.env.PI_WEB_STT_MODEL || DEFAULT_MODEL,
    apiKey: process.env.PI_WEB_STT_API_KEY || undefined,
    source: "env",
  };
}
