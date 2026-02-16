"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import clsx from "clsx";

/**
 * Tipos de estado para controlar la UX.
 */
type SendState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; code: string; expiresIn: number; createdAt: number }
  | { status: "error"; message: string };

type ReceiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; code: string; text: string }
  | { status: "error"; message: string };

/**
 * Detecta si un texto es una URL http/https válida (simple).
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export default function HomePage() {
  const [tab, setTab] = useState<"send" | "receive">("send");

  // ---------- ENVIAR ----------
  const [text, setText] = useState("");
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });

  // ---------- RECIBIR ----------
  const [codeInput, setCodeInput] = useState("");
  const [receiveState, setReceiveState] = useState<ReceiveState>({
    status: "idle",
  });

  // ---------- TOAST ----------
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const sendTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const receiveInputRef = useRef<HTMLInputElement | null>(null);

  // Evita doble auto-proceso (React StrictMode / rerenders)
  const didAutoProcessRef = useRef(false);

  /**
   * Muestra un toast flotante por unos segundos.
   */
  function showToast(message: string) {
    setToast(message);

    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 1800);
  }

  // Autofocus según tab
  useEffect(() => {
    if (tab === "send") sendTextareaRef.current?.focus();
    if (tab === "receive") receiveInputRef.current?.focus();
  }, [tab]);

  // Contador de expiración (solo si hay success)
  const secondsLeft = useMemo(() => {
    if (sendState.status !== "success") return null;
    const elapsed = Math.floor((Date.now() - sendState.createdAt) / 1000);
    return Math.max(0, sendState.expiresIn - elapsed);
  }, [sendState]);

  const expiresLabel = useMemo(() => {
    if (secondsLeft === null) return "";
    const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
    const ss = String(secondsLeft % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [secondsLeft]);

  // Tick cada 1s para el contador
  useEffect(() => {
    if (sendState.status !== "success") return;
    const t = setInterval(() => {
      // fuerza recompute del memo leyendo Date.now()
      setSendState((prev) => {
        if (prev.status !== "success") return prev;
        return { ...prev };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [sendState.status]);

  /**
   * GET /api/fetch/:code
   * Recupera y auto-destruye el contenido.
   */
  async function handleFetch(codeRaw?: string) {
    const code = String(codeRaw ?? codeInput).trim().toUpperCase();

    if (code.length < 4) {
      setReceiveState({
        status: "error",
        message: "Ingresa el código completo (4 caracteres).",
      });
      return;
    }

    setReceiveState({ status: "loading" });

    try {
      const res = await fetch(`/api/fetch/${encodeURIComponent(code)}`);
      const data = await res.json();

      if (!res.ok) {
        setReceiveState({
          status: "error",
          message: data?.error ?? "Código inválido o expirado.",
        });
        return;
      }

      setReceiveState({
        status: "success",
        code: data.code,
        text: data.text,
      });
    } catch {
      setReceiveState({
        status: "error",
        message: "No se pudo conectar. Revisa tu servidor.",
      });
    }
  }

  /**
   * Copiar al portapapeles con toast (sin alert).
   */
  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Copiado ✅");
    } catch {
      showToast("No se pudo copiar ❌");
    }
  }

  /**
   * POST /api/share
   * Envía el texto al backend y recibe un código.
   *
   * - textOverride: usado para casos donde el texto llega por query (?text=...)
   *   o por Share Sheet desde Android.
   */
  async function handleGenerate(textOverride?: string) {
    const clean = String(textOverride ?? text).trim();

    if (!clean) {
      setSendState({
        status: "error",
        message: "Pega un texto o link primero.",
      });
      return;
    }

    setSendState({ status: "loading" });

    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSendState({
          status: "error",
          message: data?.error ?? "Error al generar el código.",
        });
        return;
      }

      // Si venía de share/query, reflejamos el texto en el textarea.
      setText(clean);

      setSendState({
        status: "success",
        code: data.code,
        expiresIn: data.expiresIn,
        createdAt: Date.now(),
      });

      showToast("Código generado ✅");
    } catch {
      setSendState({
        status: "error",
        message: "No se pudo conectar. Revisa tu servidor.",
      });
    }
  }

  /**
   * Normaliza input de código:
   * - Mayúsculas
   * - Solo alfanumérico
   * - Máx 4
   */
  function onCodeChange(v: string) {
    const cleaned = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    setCodeInput(cleaned);

    // Auto fetch al completar 4 chars
    if (cleaned.length === 4) {
      handleFetch(cleaned);
    }
  }

  /**
   * Auto-detección por query:
   * 1) Recibir:  ?code=ABCD
   * 2) Compartir / share_target / TWA: ?title=...&text=...&url=...&auto=1
   *
   * Reglas:
   * - Si viene "code", manda a RECIBIR.
   * - Si NO viene "code" pero viene title/text/url, manda a ENVIAR y precarga textarea.
   * - Si auto=1 => genera el código automáticamente.
   * - Limpia la URL para evitar duplicados al refrescar.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (didAutoProcessRef.current) return;

    const params = new URLSearchParams(window.location.search);

    // 1) Prioridad: recibir por link ?code=ABCD
    const codeFromUrl = params.get("code");
    if (codeFromUrl) {
      didAutoProcessRef.current = true;

      const normalized = codeFromUrl.toUpperCase().slice(0, 4);
      setTab("receive");
      setCodeInput(normalized);
      handleFetch(normalized);

      // Limpia URL
      window.history.replaceState(null, "", "/");
      return;
    }

    // 2) Compartir: title/text/url (+ auto=1)
    const sharedTitle = (params.get("title") ?? "").trim();
    const sharedText = (params.get("text") ?? "").trim();
    const sharedUrl = (params.get("url") ?? "").trim();
    const auto = (params.get("auto") ?? "").trim(); // "1" recomendado

    if (sharedTitle || sharedText || sharedUrl) {
      didAutoProcessRef.current = true;

      const payload = [sharedTitle, sharedText, sharedUrl]
        .filter(Boolean)
        .join("\n")
        .trim();

      setTab("send");
      setText(payload);
      showToast("Contenido recibido ✅");

      // Si auto=1, generamos de una.
      if (auto === "1") {
        void handleGenerate(payload);
      }

      // Limpia URL
      window.history.replaceState(null, "", "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shareLink = useMemo(() => {
    if (sendState.status !== "success") return "";
    return `${window.location.origin}/?code=${sendState.code}`;
  }, [sendState]);

  // Determina si el contenido recibido es URL
  const receivedIsUrl =
    receiveState.status === "success" && isHttpUrl(receiveState.text);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-50">
      <div className="mx-auto max-w-2xl px-4 py-10">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">ClipCode</h1>
          <p className="mt-2 text-sm text-neutral-300">
            Pasa texto y links entre dispositivos con un código. Sin cuenta.
          </p>
        </header>

        {/* Tabs */}
        <div className="mb-6 flex rounded-xl bg-neutral-900 p-1">
          <button
            className={clsx(
              "flex-1 rounded-lg px-4 py-2 text-sm font-medium transition",
              tab === "send"
                ? "bg-neutral-50 text-neutral-950"
                : "text-neutral-200 hover:bg-neutral-800"
            )}
            onClick={() => setTab("send")}
          >
            Enviar
          </button>
          <button
            className={clsx(
              "flex-1 rounded-lg px-4 py-2 text-sm font-medium transition",
              tab === "receive"
                ? "bg-neutral-50 text-neutral-950"
                : "text-neutral-200 hover:bg-neutral-800"
            )}
            onClick={() => setTab("receive")}
          >
            Recibir
          </button>
        </div>

        {/* Panel ENVIAR */}
        {tab === "send" && (
          <section className="rounded-2xl bg-neutral-900 p-5 shadow">
            <h2 className="text-lg font-semibold">Pega aquí</h2>
            <p className="mt-1 text-sm text-neutral-300">
              Links, texto, claves… Se destruye al leer y expira solo.
            </p>

            <textarea
              ref={sendTextareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="mt-4 h-32 w-full resize-none rounded-xl bg-neutral-950 p-3 text-sm outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
              placeholder="Pega un link o texto..."
            />

            <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
              <span>{text.length} / 5000</span>
              {sendState.status === "success" && (
                <span>Expira en: {expiresLabel}</span>
              )}
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={() => handleGenerate()}
                disabled={sendState.status === "loading"}
                className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-60"
              >
                {sendState.status === "loading"
                  ? "Generando..."
                  : "Generar código"}
              </button>

              <button
                onClick={() => {
                  setText("");
                  setSendState({ status: "idle" });
                }}
                className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-neutral-700"
              >
                Nuevo
              </button>
            </div>

            {sendState.status === "error" && (
              <div className="mt-4 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {sendState.message}
              </div>
            )}

            {sendState.status === "success" && (
              <div className="mt-6 rounded-2xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-5xl font-bold tracking-widest">
                    {sendState.code}
                  </div>

                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                      onClick={() => copyToClipboard(sendState.code)}
                    >
                      Copiar código
                    </button>

                    <button
                      className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100"
                      onClick={() => copyToClipboard(shareLink)}
                    >
                      Copiar link
                    </button>
                  </div>

                  <div className="rounded-2xl bg-white p-3">
                    <QRCodeCanvas value={shareLink || sendState.code} size={180} />
                  </div>

                  <p className="text-xs text-neutral-400">
                    Consejo: en el otro dispositivo abre la web y escribe el
                    código.
                  </p>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Panel RECIBIR */}
        {tab === "receive" && (
          <section className="rounded-2xl bg-neutral-900 p-5 shadow">
            <h2 className="text-lg font-semibold">Ingresa el código</h2>
            <p className="mt-1 text-sm text-neutral-300">
              Al recuperar, se elimina automáticamente (1 lectura).
            </p>

            <input
              ref={receiveInputRef}
              value={codeInput}
              onChange={(e) => onCodeChange(e.target.value)}
              className="mt-4 w-full rounded-xl bg-neutral-950 p-3 text-center text-2xl tracking-widest outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
              placeholder="A7F3"
              inputMode="text"
              autoCapitalize="characters"
            />

            <div className="mt-4 flex gap-3">
              <button
                onClick={() => handleFetch()}
                disabled={receiveState.status === "loading"}
                className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-60"
              >
                {receiveState.status === "loading" ? "Buscando..." : "Recibir"}
              </button>

              <button
                onClick={() => {
                  setCodeInput("");
                  setReceiveState({ status: "idle" });
                }}
                className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-neutral-700"
              >
                Limpiar
              </button>
            </div>

            {receiveState.status === "error" && (
              <div className="mt-4 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {receiveState.message}
              </div>
            )}

            {receiveState.status === "success" && (
              <div className="mt-6 rounded-2xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-neutral-300">
                    Código:{" "}
                    <span className="font-semibold text-neutral-50">
                      {receiveState.code}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    {receivedIsUrl && (
                      <a
                        href={receiveState.text.trim()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                      >
                        Abrir enlace
                      </a>
                    )}

                    <button
                      className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                      onClick={() => copyToClipboard(receiveState.text)}
                    >
                      Copiar
                    </button>
                  </div>
                </div>

                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-neutral-900 p-3 text-sm text-neutral-100 ring-1 ring-neutral-800">
                  {receiveState.text}
                </pre>
              </div>
            )}
          </section>
        )}

        <footer className="mt-10 text-center text-xs text-neutral-500">
          ClipCode • MVP • Sin cuentas • Expira automático
        </footer>
      </div>

      {/* Toast flotante */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-neutral-900 px-4 py-2 text-sm text-neutral-100 shadow-lg ring-1 ring-neutral-700">
          {toast}
        </div>
      )}
    </main>
  );
}
