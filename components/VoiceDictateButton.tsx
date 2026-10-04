"use client";

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * VoiceDictateButton — the voice recording control that sits next to Send.
 *
 * States:
 *   idle      → 🎤 trigger button
 *   recording → [⏹ Stop] [📤 Send] — Stop inserts the transcript into the
 *               composer; Send sends it straight to the chat
 *   finishing → spinner while the last segments drain; the transcript then
 *               lands according to the action chosen at stop time
 *
 * Recording model: audio is cut into SEGMENT_MS segments; each closed segment
 * joins a FIFO transcription chain while the next one records on the same
 * stream, so a long dictation streams through the server progressively and
 * memory stays bounded. Segments accumulate here (never in the composer) and
 * are handed over exactly once, when the backlog drains after stop.
 *
 * Codec choice: Safari (iOS) produces audio/mp4 (AAC); Chromium/Firefox
 * produce audio/webm (opus). Both decode fine upstream via ffmpeg.
 */

export type VoicePhase = "idle" | "recording" | "finishing";
type StopAction = "insert" | "send";

export interface VoiceDictateHandle {
  /** Toggle recording — Shift+A path. Recording → stop with insert action. */
  toggle: () => void;
}

interface VoiceDictateButtonProps {
  /** Insert action: transcript lands in the composer for review. */
  onInsertTranscript: (text: string) => void;
  /** Send action: transcript goes straight to the chat. */
  onSendTranscript: (text: string) => void;
  /** Visible status for outcomes a mobile user can't see via tooltips. */
  onNotice?: (message: string, tone: "info" | "error") => void;
  /** Lets the parent hide its own Send/steer buttons while voice is active. */
  onPhaseChange?: (phase: VoicePhase) => void;
  disabled?: boolean;
}

// Segment length. Long enough that mid-word cuts are rare and per-segment
// overhead (upload + decode + model warm-up) amortizes; short enough that
// transcripts start landing within the first minute of a long monologue.
const SEGMENT_MS = 60_000;

function pickRecorderMime(): string | undefined {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}

export const VoiceDictateButton = forwardRef<VoiceDictateHandle, VoiceDictateButtonProps>(function VoiceDictateButton(
  {
    onInsertTranscript,
    onSendTranscript,
    onNotice,
    onPhaseChange,
    disabled = false,
  }: VoiceDictateButtonProps,
  ref,
) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<VoicePhase>("idle");
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
  const transcriptRef = useRef(""); // accumulated segments
  const stopActionRef = useRef<StopAction>("insert"); // chosen when recording stops

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
    const next: VoicePhase = activeRef.current ? "recording" : pendingRef.current > 0 ? "finishing" : "idle";
    setPhase(next);
    onPhaseChange?.(next);
  }, [onPhaseChange]);

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
            transcriptRef.current = transcriptRef.current
              ? `${transcriptRef.current} ${text}`
              : text;
            if (mountedRef.current) onNotice?.(`${t("chat.voiceSegmentOk")} (+${text.split(/\s+/).length})`, "info");
          } else if (mountedRef.current) {
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
          // Recording finished and the backlog drained: commit point — hand
          // over the whole transcript exactly once, per the chosen action.
          if (!activeRef.current && pendingRef.current === 0 && mountedRef.current) {
            const full = transcriptRef.current.trim();
            transcriptRef.current = "";
            if (full) {
              if (stopActionRef.current === "send") onSendTranscript(full);
              else onInsertTranscript(full);
            } else {
              onNotice?.(t("chat.voiceEmpty"), "error");
            }
          }
          syncPhase();
        }
      };
      chainRef.current = chainRef.current.then(run, run);
      return chainRef.current;
    },
    [onInsertTranscript, onNotice, onSendTranscript, syncPhase, t],
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
    stopActionRef.current = "insert";
    transcriptRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
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

  const stopRecording = useCallback(
    (action: StopAction) => {
      stopActionRef.current = action;
      activeRef.current = false;
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop(); // onstop drains the stream + final segment
      } else {
        // Between segments (recorder just closed, next not yet started): the
        // in-flight onstop sees activeRef=false and drains from there.
        syncPhase();
      }
    },
    [syncPhase],
  );

  const toggle = useCallback(() => {
    if (phase === "recording") stopRecording("insert");
    else if (phase === "idle") void startRecording();
    // "finishing" is not actionable — the backlog is draining in order.
  }, [phase, startRecording, stopRecording]);

  useImperativeHandle(ref, () => ({ toggle }), [toggle]);

  const iconStyle = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    padding: 0,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.15s, color 0.15s",
  } as const;

  if (phase === "recording") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => stopRecording("insert")}
          disabled={disabled}
          title={t("chat.voiceStopTitle")}
          aria-label={t("chat.voiceStopTitle")}
          style={{
            ...iconStyle,
            gap: 5,
            width: "auto",
            padding: disabled ? "7px 12px" : "7px 12px",
            background: "none",
            border: "1px solid var(--border, rgba(128,128,128,0.35))",
            color: "var(--text)",
            opacity: disabled ? 0.5 : 1,
            animation: "voice-pulse 1.2s ease-in-out infinite",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
          </svg>
          {!isMobileLike() && t("chat.voiceStopButton")}
        </button>
        <button
          type="button"
          onClick={() => stopRecording("send")}
          disabled={disabled}
          title={t("chat.voiceSendTitle")}
          aria-label={t("chat.voiceSendTitle")}
          style={{
            ...iconStyle,
            gap: 5,
            width: "auto",
            padding: "7px 12px",
            background: "var(--accent)",
            color: "var(--accent-contrast)",
            boxShadow: "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="2" y1="7" x2="11" y2="7" />
            <polyline points="7.5 3 12 7 7.5 11" />
          </svg>
          {!isMobileLike() && t("chat.voiceSendButton")}
        </button>
        <style jsx>{`
          @keyframes voice-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.55; }
          }
        `}</style>
      </div>
    );
  }

  if (phase === "finishing") {
    return (
      <button
        type="button"
        disabled
        title={`${t("chat.voiceTranscribing")}${pendingRef.current > 0 ? ` (${pendingRef.current})` : ""}`}
        aria-label={t("chat.voiceTranscribing")}
        style={{
          ...iconStyle,
          background: "none",
          color: "var(--text-muted)",
          cursor: "wait",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "voice-spin 1s linear infinite" }}>
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
        <style jsx>{`
          @keyframes voice-spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void startRecording()}
      disabled={disabled}
      title={error ? `${t("chat.voiceDictate")} — ${error}` : t("chat.voiceDictate")}
      aria-label={t("chat.voiceDictate")}
      style={{
        ...iconStyle,
        alignSelf: "flex-end",
        background: "var(--bg-panel)",
        color: error ? "#f59e0b" : "var(--text-muted)",
        opacity: disabled ? 0.5 : 1,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--bg-panel)";
        e.currentTarget.style.color = error ? "#f59e0b" : "var(--text-muted)";
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    </button>
  );
});

// Matches ChatInput's useIsMobile breakpoint without importing the hook into
// this leaf twice — icon-only labels under ~640px, like the Send button.
function isMobileLike(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 640;
}
