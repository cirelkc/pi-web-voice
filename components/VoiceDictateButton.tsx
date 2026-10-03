"use client";

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * VoiceDictateButton — mic button for the chat composer.
 *
 * Records in-browser via MediaRecorder, transcribes through the same-origin
 * /api/stt proxy (which forwards to a self-hosted OpenAI-compatible
 * transcription endpoint), and hands the transcript to the composer.
 *
 * Long-recording strategy: the recording is cut into SEGMENT_MS segments.
 * When a segment closes, the next one starts immediately on the same stream
 * and the closed segment joins a FIFO transcription chain — so a long
 * dictation streams into the composer progressively instead of buffering the
 * whole recording in memory and transcribing one giant blob at the end.
 * Segments are transcribed strictly in order (one in flight), so appended
 * text is always chronological.
 *
 * Segment boundaries can occasionally clip a word (each segment is a
 * self-contained file; MediaRecorder offers no rewind). 60s segments make
 * that rare enough for dictation use while keeping memory and per-request
 * latency bounded.
 *
 * Codec choice: Safari (iOS) only produces audio/mp4 (AAC); Chromium/Firefox
 * produce audio/webm (opus). Both decode fine upstream via ffmpeg, so we pick
 * whatever the browser natively supports rather than transcoding client-side.
 */

type Phase = "idle" | "recording" | "finishing";

// Segment length. Long enough that mid-word cuts are rare and per-segment
// overhead (upload + decode + model warm-up) amortizes; short enough that
// transcripts start landing within the first minute of a long monologue.
const SEGMENT_MS = 60_000;
function pickRecorderMime(): string | undefined {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}


export interface VoiceDictateHandle {
  /** Toggle recording — same as clicking the button. No-op while draining. */
  toggle: () => void;
}

interface VoiceDictateButtonProps {
  onTranscript: (text: string) => void;
  /** Visible status for outcomes a mobile user can't see via tooltips. */
  onNotice?: (message: string, tone: "info" | "error") => void;
  /**
   * When true, segments accumulate silently (no composer insertion) and the
   * full transcript is handed to onFinalTranscript once the recording stops
   * and every segment has transcribed — one dictation, one prompt.
   */
  autoSend?: boolean;
  onFinalTranscript?: (text: string) => void;
  disabled?: boolean;
}

export const VoiceDictateButton = forwardRef<VoiceDictateHandle, VoiceDictateButtonProps>(function VoiceDictateButton(
  {
    onTranscript,
    onNotice,
    autoSend = false,
    onFinalTranscript,
    disabled = false,
  }: VoiceDictateButtonProps,
  ref,
) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);
  const activeRef = useRef(false); // user still recording (vs draining backlog)
  const pendingRef = useRef(0); // segments queued but not yet transcribed
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeRef = useRef<{ mimeType?: string; extension: string }>({ extension: "webm" });
  const transcriptRef = useRef(""); // accumulated segments (autoSend mode)

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Recording mid-unmount (navigation, composer teardown): stop cleanly.
      activeRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Phase is derived: recording while active, else draining queued segments.
  const syncPhase = useCallback(() => {
    if (!mountedRef.current) return;
    setPhase(activeRef.current ? "recording" : pendingRef.current > 0 ? "finishing" : "idle");
  }, []);

  const transcribeSegment = useCallback(
    (blob: Blob, extension: string): Promise<void> => {
      pendingRef.current += 1;
      syncPhase();
      // Serial chain: segments append in recording order, one request in
      // flight. A failed segment logs to the composer notice line and skips —
      // the chain must never reject, or every later segment would be dropped.
      const run = async () => {
        try {
          const form = new FormData();
          form.append("file", blob, `dictation.${extension}`);
          const response = await fetch("/api/stt", { method: "POST", body: form });
          const data = (await response.json().catch(() => null)) as
            | { text?: string; error?: string; detail?: string }
            | null;
          if (!response.ok) {
            throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
          }
          const text = (data?.text ?? "").trim();
          if (text && mountedRef.current) {
            if (autoSend) {
              transcriptRef.current = transcriptRef.current
                ? `${transcriptRef.current} ${text}`
                : text;
            } else {
              onTranscript(text);
            }
            if (mountedRef.current) onNotice?.(`${t("chat.voiceSegmentOk")} (+${text.split(/\s+/).length})`, "info");
          } else if (mountedRef.current) {
            // Empty transcript: usually a silent/muted mic track (known iOS
            // quirk) or pure silence. Say so instead of doing nothing.
            onNotice?.(t("chat.voiceEmpty"), "error");
          }
        } catch (err) {
          if (mountedRef.current) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            onNotice?.(`${t("chat.voiceFailed")}: ${message}`, "error");
          }
        } finally {
          pendingRef.current -= 1;
          // Recording finished and the backlog drained: in autoSend mode this
          // is the commit point — hand over the whole transcript exactly once.
          if (!activeRef.current && pendingRef.current === 0 && mountedRef.current) {
            const full = transcriptRef.current.trim();
            transcriptRef.current = "";
            if (autoSend) {
              if (full) onFinalTranscript?.(full);
              else onNotice?.(t("chat.voiceEmpty"), "error");
            }
          }
          syncPhase();
        }
      };
      chainRef.current = chainRef.current.then(run, run);
      return chainRef.current;
    },
    [autoSend, onFinalTranscript, onNotice, onTranscript, syncPhase, t],
  );

  const startSegmentRecorder = useCallback(
    (mimeType?: string) => {
      const stream = streamRef.current;
      if (!stream) return;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size > 0) transcribeSegment(blob, mimeRef.current.extension);
        else syncPhase();
        if (activeRef.current && mountedRef.current) {
          // Seamless continuation: same stream, fresh container — the gap
          // between stop() and the next start() is a few milliseconds.
          startSegmentRecorder(mimeType);
        } else {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          releaseStream();
          syncPhase();
        }
      };
      recorder.start(1000); // timeslice: bounded chunk loss if the tab dies
    },
    [releaseStream, syncPhase, transcribeSegment],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      transcriptRef.current = "";
      const mimeType = pickRecorderMime();
      mimeRef.current = {
        mimeType,
        extension: mimeType?.startsWith("audio/mp4")
          ? "m4a"
          : mimeType?.startsWith("audio/ogg")
            ? "ogg"
            : "webm",
      };
      activeRef.current = true;
      startSegmentRecorder(mimeType);
      // Segment flush: stop the current recorder; its onstop handler starts
      // the next one and queues the closed segment for transcription.
      timerRef.current = setInterval(() => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      }, SEGMENT_MS);
      syncPhase();
    } catch (err) {
      releaseStream();
      if (mountedRef.current) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onNotice?.(`${t("chat.voiceMicError")}: ${message}`, "error");
        activeRef.current = false;
        syncPhase();
      }
    }
  }, [onNotice, releaseStream, startSegmentRecorder, syncPhase, t]);

  const stopRecording = useCallback(() => {
    activeRef.current = false;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop(); // onstop drains the stream + final segment
    } else {
      // Between segments (recorder just closed, next not yet started): the
      // in-flight onstop sees activeRef=false and drains from there.
      syncPhase();
    }
  }, [syncPhase]);

  const handleClick = useCallback(() => {
    if (phase === "recording") stopRecording();
    else if (phase === "idle") void startRecording();
    // "finishing" is not clickable — the backlog is draining in order.
  }, [phase, startRecording, stopRecording]);

  useImperativeHandle(ref, () => ({ toggle: () => handleClick() }), [handleClick]);

  const label =
    phase === "recording"
      ? t("chat.voiceStop")
      : phase === "finishing"
        ? `${t("chat.voiceTranscribing")}${pendingRef.current > 0 ? ` (${pendingRef.current})` : ""}`
        : t("chat.voiceDictate");

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || phase === "finishing"}
        title={error ? `${label} — ${error}` : label}
        aria-label={label}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: phase === "recording" ? "rgba(239,68,68,0.15)" : "none",
          border: "none",
          borderRadius: 9,
          color: phase === "recording" ? "#ef4444" : error ? "#f59e0b" : "var(--text-muted)",
          cursor: phase === "finishing" ? "wait" : "pointer",
          opacity: 1,
          animation: phase === "recording" ? "voice-pulse 1.2s ease-in-out infinite" : undefined,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (phase !== "recording") e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (phase !== "recording") e.currentTarget.style.background = "none";
        }}
      >
        {phase === "finishing" ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
            <path d="M21 12a9 9 0 1 1-6.2-8.56" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        )}
      </button>
      <style jsx>{`
        @keyframes voice-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
});
