"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * VoiceDictateButton — mic button for the chat composer.
 *
 * Records in-browser via MediaRecorder, transcribes through the same-origin
 * /api/stt proxy (which forwards to a self-hosted OpenAI-compatible
 * transcription endpoint), and hands the transcript to the composer.
 *
 * Codec choice: Safari (iOS) only produces audio/mp4 (AAC); Chromium/Firefox
 * produce audio/webm (opus). Both decode fine upstream via ffmpeg, so we pick
 * whatever the browser natively supports rather than transcoding client-side.
 */

type Phase = "idle" | "recording" | "transcribing";

function pickRecorderMime(): string | undefined {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}

export function VoiceDictateButton({
  onTranscript,
  disabled = false,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Recording mid-unmount (navigation, composer teardown): release the mic.
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, extension: string) => {
      setPhase("transcribing");
      setError(null);
      try {
        const form = new FormData();
        form.append("file", blob, `dictation.${extension}`);
        const response = await fetch("/api/stt", { method: "POST", body: form });
        const data = (await response.json().catch(() => null)) as { text?: string; error?: string; detail?: string } | null;
        if (!response.ok) {
          throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
        }
        const text = (data?.text ?? "").trim();
        if (text) onTranscript(text);
        setPhase("idle");
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase("idle");
        }
      }
    },
    [onTranscript],
  );

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

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
      const mimeType = pickRecorderMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      const extension = mimeType?.startsWith("audio/mp4") ? "m4a" : mimeType?.startsWith("audio/ogg") ? "ogg" : "webm";
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        releaseStream();
        recorderRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        chunksRef.current = [];
        // Zero-byte recording (instant tap) — skip the round-trip.
        if (blob.size > 0) void transcribe(blob, extension);
        else if (mountedRef.current) setPhase("idle");
      };
      recorder.start(1000); // timeslice: bounded chunk loss if the tab dies
      setPhase("recording");
    } catch (err) {
      releaseStream();
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    }
  }, [releaseStream, transcribe]);

  const handleClick = () => {
    if (phase === "recording") stopRecording();
    else if (phase === "idle") void startRecording();
    // "transcribing" is not clickable — the round-trip is in flight.
  };

  const label =
    phase === "recording"
      ? t("chat.voiceStop")
      : phase === "transcribing"
        ? t("chat.voiceTranscribing")
        : t("chat.voiceDictate");

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || phase === "transcribing"}
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
          cursor: phase === "transcribing" ? "wait" : "pointer",
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
        {phase === "transcribing" ? (
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
}
