"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import clsx from "clsx";

type SendState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; code: string; expiresIn: number; createdAt: number }
  | { status: "error"; message: string };

type ReceiveState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "success";
      code: string;
      links: string[];
      text?: string;
      sourceDeviceLabel?: string;
    }
  | { status: "error"; message: string };

type PairState =
  | { status: "idle" }
  | { status: "linking" }
  | { status: "linked"; receiverDeviceId: string; receiverDeviceLabel?: string }
  | { status: "error"; message: string };

type NearbyState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "empty" }
  | { status: "error"; message: string };

const TTL_OPTIONS = [
  { label: "3 min", value: 180 },
  { label: "5 min", value: 300 },
  { label: "10 min", value: 600 },
  { label: "30 min", value: 1800 },
  { label: "60 min", value: 3600 },
];

const MAX_LINKS = 10;
const MIN_VISIBLE_LINK_INPUTS = 3;
const DEVICE_ID_STORAGE_KEY = "clipcode:device-id";
const DEVICE_LABEL_STORAGE_KEY = "clipcode:device-label";
const PAIRED_RECEIVER_STORAGE_KEY = "clipcode:paired-receiver";

type PairedReceiverInfo = {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeCode(value: string, maxLength: number): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, maxLength);
}

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

function normalizeDeviceLabel(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

function createDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `dev${Math.random().toString(36).slice(2, 14)}`;
}

function fallbackDeviceLabel(deviceId: string): string {
  const shortId = deviceId.slice(-4).toUpperCase();
  return shortId ? `Dispositivo ${shortId}` : "Mi dispositivo";
}

function shortenLink(value: string): string {
  try {
    const url = new URL(value);
    const full = `${url.hostname}${url.pathname}${url.search}`;
    return full.length > 48 ? `${full.slice(0, 48)}...` : full;
  } catch {
    return value.length > 48 ? `${value.slice(0, 48)}...` : value;
  }
}

function fromSharedQuery(params: URLSearchParams): { links: string[]; text?: string } {
  const sharedTitle = (params.get("title") ?? "").trim();
  const sharedText = (params.get("text") ?? "").trim();
  const sharedUrl = (params.get("url") ?? "").trim();

  const links = sharedUrl && isHttpUrl(sharedUrl) ? [sharedUrl] : [];
  const textParts = [sharedTitle, sharedText].filter(Boolean);
  const text = textParts.join("\n").trim();

  return {
    links,
    text: text || undefined,
  };
}

export default function HomePage() {
  const [tab, setTab] = useState<"send" | "receive">("send");

  const [linkInputs, setLinkInputs] = useState<string[]>(["", "", ""]);
  const [showTextComposer, setShowTextComposer] = useState(false);
  const [text, setText] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(300);
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });

  const [codeInput, setCodeInput] = useState("");
  const [receiveState, setReceiveState] = useState<ReceiveState>({ status: "idle" });
  const [receiveTextOpen, setReceiveTextOpen] = useState(true);

  const [pairCodeInput, setPairCodeInput] = useState("");
  const [pairingCode, setPairingCode] = useState<{
    code: string;
    expiresIn: number;
    createdAt: number;
  } | null>(null);
  const [pairState, setPairState] = useState<PairState>({ status: "idle" });
  const [nearbyState, setNearbyState] = useState<NearbyState>({ status: "idle" });
  const [deviceId, setDeviceId] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const nearbyPollTimerRef = useRef<number | null>(null);
  const didAutoProcessRef = useRef(false);

  const sendTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const receiveInputRef = useRef<HTMLInputElement | null>(null);

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

  function clearNearbyPollTimer() {
    if (nearbyPollTimerRef.current) {
      window.clearTimeout(nearbyPollTimerRef.current);
      nearbyPollTimerRef.current = null;
    }
  }

  function readPairedReceiverInfo(): PairedReceiverInfo | null {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(PAIRED_RECEIVER_STORAGE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as PairedReceiverInfo;
      const receiverDeviceId = normalizeDeviceId(parsed?.receiverDeviceId);
      if (!receiverDeviceId) return null;
      const receiverDeviceLabel = normalizeDeviceLabel(parsed?.receiverDeviceLabel);
      return {
        receiverDeviceId,
        receiverDeviceLabel: receiverDeviceLabel || undefined,
      };
    } catch {
      // Compatibilidad con formato viejo (string plano).
      const receiverDeviceId = normalizeDeviceId(raw);
      if (!receiverDeviceId) return null;
      return { receiverDeviceId };
    }
  }

  function savePairedReceiverInfo(info: PairedReceiverInfo) {
    localStorage.setItem(PAIRED_RECEIVER_STORAGE_KEY, JSON.stringify(info));
  }

  function persistDeviceLabel(nextLabel: string) {
    const normalized = normalizeDeviceLabel(nextLabel);
    const resolved = normalized || fallbackDeviceLabel(deviceId);
    setDeviceLabel(resolved);
    if (typeof window !== "undefined") {
      localStorage.setItem(DEVICE_LABEL_STORAGE_KEY, resolved);
    }
  }

  const cleanedLinks = useMemo(
    () => linkInputs.map((value) => value.trim()).filter(Boolean),
    [linkInputs]
  );

  const invalidLinkIndexes = useMemo(() => {
    const result: number[] = [];
    linkInputs.forEach((value, index) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (!isHttpUrl(trimmed)) {
        result.push(index);
      }
    });
    return result;
  }, [linkInputs]);

  const canAddLinkInput = linkInputs.length < MAX_LINKS;

  useEffect(() => {
    if (tab === "send") sendTextareaRef.current?.focus();
    if (tab === "receive") receiveInputRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = normalizeDeviceId(localStorage.getItem(DEVICE_ID_STORAGE_KEY));
    const resolvedDeviceId = stored || createDeviceId();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, resolvedDeviceId);
    setDeviceId(resolvedDeviceId);

    const storedLabel = normalizeDeviceLabel(
      localStorage.getItem(DEVICE_LABEL_STORAGE_KEY)
    );
    const resolvedLabel = storedLabel || fallbackDeviceLabel(resolvedDeviceId);
    localStorage.setItem(DEVICE_LABEL_STORAGE_KEY, resolvedLabel);
    setDeviceLabel(resolvedLabel);

    const pairedReceiver = readPairedReceiverInfo();
    if (pairedReceiver) {
      setPairState({
        status: "linked",
        receiverDeviceId: pairedReceiver.receiverDeviceId,
        receiverDeviceLabel: pairedReceiver.receiverDeviceLabel,
      });
    }
  }, []);

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

  useEffect(() => {
    if (sendState.status !== "success") return;
    const timer = window.setInterval(() => {
      setSendState((prev) => {
        if (prev.status !== "success") return prev;
        return { ...prev };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sendState.status]);

  async function handleFetch(codeRaw?: string) {
    const code = normalizeCode(String(codeRaw ?? codeInput), 4);

    if (code.length < 4) {
      setReceiveState({
        status: "error",
        message: "Ingresa el codigo completo (4 caracteres).",
      });
      return;
    }

    setReceiveState({ status: "loading" });

    try {
      const res = await fetch(`/api/fetch/${encodeURIComponent(code)}`);
      const data = (await res.json()) as {
        code?: string;
        links?: string[];
        text?: string;
        error?: string;
      };

      if (!res.ok) {
        const fallback =
          "No se encontro el codigo. Puede haber expirado o ya fue consumido. Genera uno nuevo e intenta de nuevo.";
        setReceiveState({
          status: "error",
          message: data?.error ?? fallback,
        });
        return;
      }

      const links = Array.isArray(data?.links)
        ? data.links.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      const receivedText = String(data?.text ?? "").trim();

      setReceiveTextOpen(true);
      setReceiveState({
        status: "success",
        code: String(data?.code ?? code),
        links,
        text: receivedText || undefined,
        sourceDeviceLabel: undefined,
      });
      setNearbyState({ status: "idle" });
    } catch {
      setReceiveState({
        status: "error",
        message: "No se pudo conectar. Revisa tu servidor.",
      });
    }
  }

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Copiado");
    } catch {
      showToast("No se pudo copiar");
    }
  }

  function applyPayloadToComposer(payload: { links: string[]; text?: string }) {
    const nextLinks = [...payload.links];
    while (nextLinks.length < MIN_VISIBLE_LINK_INPUTS) nextLinks.push("");
    setLinkInputs(nextLinks.slice(0, MAX_LINKS));

    const normalizedText = String(payload.text ?? "").trim();
    setText(normalizedText);
    setShowTextComposer(Boolean(normalizedText));
  }

  async function handleGenerate(payloadOverride?: { links: string[]; text?: string }) {
    const payload = payloadOverride ?? {
      links: cleanedLinks,
      text: text.trim() || undefined,
    };

    const links = payload.links.map((value) => value.trim()).filter(Boolean);
    const textValue = String(payload.text ?? "").trim();

    if (!links.length && !textValue) {
      setSendState({
        status: "error",
        message: "Agrega al menos un link o texto.",
      });
      return;
    }

    if (links.length > MAX_LINKS) {
      setSendState({
        status: "error",
        message: `Maximo ${MAX_LINKS} links por envio.`,
      });
      return;
    }

    if (links.some((value) => !isHttpUrl(value))) {
      setSendState({
        status: "error",
        message: "Corrige los links invalidos (solo http/https).",
      });
      return;
    }

    setSendState({ status: "loading" });

    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links,
          text: textValue || undefined,
          ttlSeconds,
          senderDeviceId: deviceId || undefined,
          senderDeviceLabel: deviceLabel || undefined,
        }),
      });

      const data = (await res.json()) as {
        code?: string;
        expiresIn?: number;
        error?: string;
      };

      if (!res.ok) {
        setSendState({
          status: "error",
          message: data?.error ?? "Error al generar el codigo.",
        });
        return;
      }

      applyPayloadToComposer({ links, text: textValue || undefined });
      setSendState({
        status: "success",
        code: String(data.code ?? ""),
        expiresIn: Number(data.expiresIn ?? ttlSeconds),
        createdAt: Date.now(),
      });

      showToast("Codigo generado");
    } catch {
      setSendState({
        status: "error",
        message: "No se pudo conectar. Revisa tu servidor.",
      });
    }
  }

  function onCodeChange(value: string) {
    const cleaned = normalizeCode(value, 4);
    setCodeInput(cleaned);

    if (cleaned.length === 4) {
      void handleFetch(cleaned);
    }
  }

  function onPairCodeChange(value: string) {
    setPairCodeInput(normalizeCode(value, 6));
  }

  async function handleCreatePairCode() {
    if (!deviceId) {
      showToast("No se pudo inicializar el dispositivo.");
      return;
    }

    try {
      const res = await fetch("/api/pair/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiverDeviceId: deviceId,
          receiverDeviceLabel: deviceLabel || undefined,
        }),
      });
      const data = (await res.json()) as {
        pairCode?: string;
        expiresIn?: number;
        error?: string;
      };

      if (!res.ok) {
        showToast(data.error ?? "No se pudo crear el pair code.");
        return;
      }

      setPairingCode({
        code: String(data.pairCode ?? ""),
        expiresIn: Number(data.expiresIn ?? 600),
        createdAt: Date.now(),
      });
      showToast("Pair code creado");
    } catch {
      showToast("No se pudo crear el pair code.");
    }
  }

  async function handleConfirmPair() {
    if (!deviceId) {
      setPairState({
        status: "error",
        message: "No se pudo inicializar el dispositivo.",
      });
      return;
    }

    const normalizedPairCode = normalizeCode(pairCodeInput, 6);
    if (normalizedPairCode.length !== 6) {
      setPairState({
        status: "error",
        message: "Ingresa el pair code completo (6 caracteres).",
      });
      return;
    }

    setPairState({ status: "linking" });

    try {
      const res = await fetch("/api/pair/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairCode: normalizedPairCode,
          senderDeviceId: deviceId,
          senderDeviceLabel: deviceLabel || undefined,
        }),
      });

      const data = (await res.json()) as {
        linked?: boolean;
        receiverDeviceId?: string;
        receiverDeviceLabel?: string;
        error?: string;
      };

      if (!res.ok || !data.linked || !data.receiverDeviceId) {
        setPairState({
          status: "error",
          message: data.error ?? "No se pudo vincular el dispositivo.",
        });
        return;
      }

      const linkedInfo: PairedReceiverInfo = {
        receiverDeviceId: data.receiverDeviceId,
        receiverDeviceLabel: normalizeDeviceLabel(data.receiverDeviceLabel) || undefined,
      };
      savePairedReceiverInfo(linkedInfo);
      setPairState({
        status: "linked",
        receiverDeviceId: linkedInfo.receiverDeviceId,
        receiverDeviceLabel: linkedInfo.receiverDeviceLabel,
      });
      showToast("Dispositivo vinculado");
    } catch {
      setPairState({
        status: "error",
        message: "No se pudo vincular el dispositivo.",
      });
    }
  }

  function handleUnlinkPair() {
    localStorage.removeItem(PAIRED_RECEIVER_STORAGE_KEY);
    setPairState({ status: "idle" });
    showToast("Vinculacion eliminada");
  }

  async function pollNearbyOnce(): Promise<{
    found: boolean;
    item?: { code?: string; links: string[]; text?: string; senderDeviceLabel?: string };
  }> {
    const res = await fetch(
      `/api/nearby/poll?receiverDeviceId=${encodeURIComponent(deviceId)}`
    );

    const data = (await res.json()) as {
      found?: boolean;
      item?: { code?: string; links?: string[]; text?: string; senderDeviceLabel?: string };
      error?: string;
    };

    if (!res.ok) {
      throw new Error(data.error ?? "Error searching nearby");
    }

    if (!data.found || !data.item) {
      return { found: false };
    }

    const links = Array.isArray(data.item.links)
      ? data.item.links.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    const textValue = String(data.item.text ?? "").trim();
    const codeValue = String(data.item.code ?? "").trim().toUpperCase();
    const senderDeviceLabel = normalizeDeviceLabel(data.item.senderDeviceLabel);

    return {
      found: true,
      item: {
        code: codeValue || undefined,
        links,
        text: textValue || undefined,
        senderDeviceLabel: senderDeviceLabel || undefined,
      },
    };
  }

  async function handleNearbySearch() {
    if (!deviceId) {
      setNearbyState({
        status: "error",
        message: "No se pudo inicializar el dispositivo.",
      });
      return;
    }

    clearNearbyPollTimer();
    setNearbyState({ status: "searching" });

    const startedAt = Date.now();
    const timeoutMs = 14_000;
    const intervalMs = 2_000;

    const tick = async () => {
      try {
        const result = await pollNearbyOnce();
        if (result.found && result.item) {
          setReceiveTextOpen(true);
          setReceiveState({
            status: "success",
            code: result.item.code ?? "PAIR",
            links: result.item.links,
            text: result.item.text,
            sourceDeviceLabel: result.item.senderDeviceLabel,
          });
          setNearbyState({ status: "idle" });
          showToast("Contenido encontrado");
          return;
        }
      } catch {
        setNearbyState({
          status: "error",
          message: "No se pudo completar la busqueda.",
        });
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        setNearbyState({ status: "empty" });
        return;
      }

      nearbyPollTimerRef.current = window.setTimeout(() => {
        void tick();
      }, intervalMs);
    };

    void tick();
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (didAutoProcessRef.current) return;

    const params = new URLSearchParams(window.location.search);

    const codeFromUrl = params.get("code");
    if (codeFromUrl) {
      didAutoProcessRef.current = true;

      const normalized = normalizeCode(codeFromUrl, 4);
      setTab("receive");
      setCodeInput(normalized);
      void handleFetch(normalized);
      window.history.replaceState(null, "", "/");
      return;
    }

    const pairFromUrl = params.get("pair");
    if (pairFromUrl) {
      didAutoProcessRef.current = true;
      const normalizedPair = normalizeCode(pairFromUrl, 6);
      setTab("send");
      setPairCodeInput(normalizedPair);
      showToast("Pair code detectado");
      window.history.replaceState(null, "", "/");
      return;
    }

    const auto = (params.get("auto") ?? "").trim();
    const fromQuery = fromSharedQuery(params);

    if (fromQuery.links.length || fromQuery.text) {
      didAutoProcessRef.current = true;
      setTab("send");
      applyPayloadToComposer(fromQuery);
      showToast("Contenido recibido");

      if (auto === "1") {
        void handleGenerate(fromQuery);
      }

      window.history.replaceState(null, "", "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      clearNearbyPollTimer();
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const shareLink = useMemo(() => {
    if (sendState.status !== "success") return "";
    if (typeof window === "undefined") return `/?code=${sendState.code}`;
    return `${window.location.origin}/?code=${sendState.code}`;
  }, [sendState]);

  const pairLink = useMemo(() => {
    if (!pairingCode) return "";
    if (typeof window === "undefined") return `/?pair=${pairingCode.code}`;
    return `${window.location.origin}/?pair=${pairingCode.code}`;
  }, [pairingCode]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-50">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-7">
          <h1 className="text-3xl font-semibold tracking-tight">ClipCode</h1>
          <p className="mt-2 text-sm text-neutral-300">
            Pasa links y texto entre dispositivos con un codigo. Sin cuenta.
          </p>
          <div className="mt-4 rounded-xl bg-neutral-900 p-3 ring-1 ring-neutral-800">
            <label className="mb-2 block text-xs font-medium text-neutral-300">
              Nombre de este dispositivo
            </label>
            <input
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(normalizeDeviceLabel(event.target.value))}
              onBlur={() => persistDeviceLabel(deviceLabel)}
              placeholder="Ej: TV Sala, iPhone Luis"
              className="w-full rounded-lg bg-neutral-950 px-3 py-2 text-sm outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
            />
          </div>
        </header>

        <div className="mb-6 flex rounded-xl bg-neutral-900 p-1">
          <button
            className={clsx(
              "flex-1 rounded-lg px-4 py-3 text-base font-medium transition",
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
              "flex-1 rounded-lg px-4 py-3 text-base font-medium transition",
              tab === "receive"
                ? "bg-neutral-50 text-neutral-950"
                : "text-neutral-200 hover:bg-neutral-800"
            )}
            onClick={() => setTab("receive")}
          >
            Recibir
          </button>
        </div>

        {tab === "send" && (
          <section className="rounded-2xl bg-neutral-900 p-5 shadow">
            <h2 className="text-lg font-semibold">Links</h2>
            <p className="mt-1 text-sm text-neutral-300">
              Hasta 10 links por envio. Se consume una sola vez al recibir.
            </p>

            <div className="mt-4 space-y-3">
              {linkInputs.map((value, index) => {
                const invalid = invalidLinkIndexes.includes(index);
                return (
                  <input
                    key={`link-${index}`}
                    value={value}
                    onChange={(event) => {
                      const next = [...linkInputs];
                      next[index] = event.target.value;
                      setLinkInputs(next);
                    }}
                    placeholder={`https://example.com/${index + 1}`}
                    className={clsx(
                      "w-full rounded-xl bg-neutral-950 px-4 py-3 text-base outline-none ring-1",
                      invalid
                        ? "ring-red-500 focus:ring-red-400"
                        : "ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
                    )}
                  />
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  if (!canAddLinkInput) return;
                  setLinkInputs((prev) => [...prev, ""]);
                }}
                disabled={!canAddLinkInput}
                className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-60"
              >
                Agregar link
              </button>

              <button
                onClick={() => setShowTextComposer((prev) => !prev)}
                className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-neutral-700"
              >
                {showTextComposer ? "Ocultar texto" : "Agregar texto"}
              </button>
            </div>

            {showTextComposer && (
              <div className="mt-4">
                <label className="mb-2 block text-sm font-medium text-neutral-200">
                  Texto (opcional)
                </label>
                <textarea
                  ref={sendTextareaRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className="h-28 w-full resize-none rounded-xl bg-neutral-950 p-3 text-sm outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
                  placeholder="Notas, codigo, instrucciones..."
                />
              </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-200">
                  Expiracion
                </label>
                <select
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(Number(event.target.value))}
                  className="w-full rounded-xl bg-neutral-950 px-4 py-3 text-base outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
                >
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-200">
                  Pair code (enviar a dispositivo vinculado)
                </label>
                <div className="flex gap-2">
                  <input
                    value={pairCodeInput}
                    onChange={(event) => onPairCodeChange(event.target.value)}
                    placeholder="ABC123"
                    className="w-full rounded-xl bg-neutral-950 px-4 py-3 text-center text-lg tracking-widest outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
                  />
                  <button
                    onClick={() => void handleConfirmPair()}
                    disabled={pairState.status === "linking"}
                    className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-semibold text-neutral-950 hover:opacity-90 disabled:opacity-60"
                  >
                    {pairState.status === "linking" ? "Vinculando..." : "Vincular"}
                  </button>
                </div>
              </div>
            </div>

            {pairState.status === "linked" && (
              <div className="mt-3 rounded-xl bg-emerald-950/30 p-3 text-sm text-emerald-200 ring-1 ring-emerald-900">
                <div>
                  Vinculado con{" "}
                  <span className="font-semibold">
                    {pairState.receiverDeviceLabel || "dispositivo remoto"}
                  </span>
                  . Buscar cerca disponible para este par.
                </div>
                <button
                  onClick={handleUnlinkPair}
                  className="mt-2 rounded-lg bg-emerald-900/70 px-3 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-900"
                >
                  Desvincular
                </button>
              </div>
            )}
            {pairState.status === "error" && (
              <div className="mt-3 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {pairState.message}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={() => void handleGenerate()}
                disabled={sendState.status === "loading"}
                className="rounded-xl bg-neutral-50 px-5 py-3 text-base font-semibold text-neutral-950 hover:opacity-90 disabled:opacity-60"
              >
                {sendState.status === "loading" ? "Enviando..." : "Enviar"}
              </button>

              <button
                onClick={() => {
                  setLinkInputs(["", "", ""]);
                  setText("");
                  setShowTextComposer(false);
                  setSendState({ status: "idle" });
                }}
                className="rounded-xl bg-neutral-800 px-5 py-3 text-base font-medium text-neutral-100 hover:bg-neutral-700"
              >
                Nuevo
              </button>
            </div>

            <div className="mt-2 text-xs text-neutral-400">
              {cleanedLinks.length} links listos / {MAX_LINKS}
            </div>

            {sendState.status === "error" && (
              <div className="mt-4 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {sendState.message}
              </div>
            )}

            {sendState.status === "success" && (
              <div className="mt-6 rounded-2xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-5xl font-bold tracking-widest">{sendState.code}</div>
                  <div className="text-sm text-neutral-300">Expira en: {expiresLabel}</div>

                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                      onClick={() => void copyToClipboard(sendState.code)}
                    >
                      Copiar codigo
                    </button>
                    <button
                      className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100"
                      onClick={() => void copyToClipboard(shareLink)}
                    >
                      Copiar link
                    </button>
                  </div>

                  <div className="rounded-2xl bg-white p-3">
                    <QRCodeCanvas value={shareLink || sendState.code} size={180} />
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "receive" && (
          <section className="rounded-2xl bg-neutral-900 p-5 shadow">
            <h2 className="text-lg font-semibold">Recibir</h2>
            <p className="mt-1 text-sm text-neutral-300">
              Puedes usar codigo manual o Buscar cerca con pairing.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <button
                onClick={() => void handleCreatePairCode()}
                className="rounded-xl bg-neutral-50 px-5 py-3 text-base font-semibold text-neutral-950 hover:opacity-90"
              >
                Vincular con código
              </button>
              <button
                onClick={() => void handleNearbySearch()}
                disabled={nearbyState.status === "searching"}
                className="rounded-xl bg-blue-600 px-5 py-3 text-base font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {nearbyState.status === "searching" ? "Buscando..." : "Buscar cerca"}
              </button>
            </div>

            {pairingCode && (
              <div className="mt-4 rounded-2xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-sm text-neutral-300">Pair code</div>
                  <div className="text-4xl font-bold tracking-widest">{pairingCode.code}</div>
                  <div className="text-xs text-neutral-400">
                    Dispositivo: {deviceLabel || "Mi dispositivo"}
                  </div>
                  <div className="text-xs text-neutral-400">
                    Expira en {Math.ceil(pairingCode.expiresIn / 60)} min
                  </div>
                  <div className="rounded-2xl bg-white p-3">
                    <QRCodeCanvas value={pairLink || pairingCode.code} size={180} />
                  </div>
                  <button
                    onClick={() => void copyToClipboard(pairingCode.code)}
                    className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                  >
                    Copiar pair code
                  </button>
                </div>
              </div>
            )}

            {nearbyState.status === "empty" && (
              <div className="mt-4 rounded-xl bg-amber-950/30 p-3 text-sm text-amber-200 ring-1 ring-amber-900">
                No se encontro nada. Verifica que hayas enviado a este dispositivo o escribe
                el codigo manual.
              </div>
            )}
            {nearbyState.status === "error" && (
              <div className="mt-4 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {nearbyState.message}
              </div>
            )}

            <div className="mt-6 rounded-xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
              <h3 className="text-sm font-semibold text-neutral-200">Modo manual por codigo</h3>
              <input
                ref={receiveInputRef}
                value={codeInput}
                onChange={(event) => onCodeChange(event.target.value)}
                className="mt-3 w-full rounded-xl bg-neutral-900 p-3 text-center text-2xl tracking-widest outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-400"
                placeholder="A7F3"
                inputMode="text"
                autoCapitalize="characters"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void handleFetch()}
                  disabled={receiveState.status === "loading"}
                  className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-semibold text-neutral-950 hover:opacity-90 disabled:opacity-60"
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
            </div>

            {receiveState.status === "error" && (
              <div className="mt-4 rounded-xl bg-red-950/40 p-3 text-sm text-red-200 ring-1 ring-red-900">
                {receiveState.message}
              </div>
            )}

            {receiveState.status === "success" && (
              <div className="mt-6 rounded-2xl bg-neutral-950 p-4 ring-1 ring-neutral-800">
                <div className="mb-3 text-sm text-neutral-300">
                  Codigo: <span className="font-semibold text-neutral-50">{receiveState.code}</span>
                </div>
                {receiveState.sourceDeviceLabel && (
                  <div className="mb-3 text-sm text-neutral-300">
                    Enviado desde:{" "}
                    <span className="font-semibold text-neutral-50">
                      {receiveState.sourceDeviceLabel}
                    </span>
                  </div>
                )}

                {!!receiveState.links.length && (
                  <div className="space-y-3">
                    {receiveState.links.map((link, index) => (
                      <div
                        key={`${link}-${index}`}
                        className="rounded-xl bg-neutral-900 p-3 ring-1 ring-neutral-800"
                      >
                        <div className="text-sm text-neutral-200">{shortenLink(link)}</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                          >
                            Abrir
                          </a>
                          <button
                            onClick={() => void copyToClipboard(link)}
                            className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                          >
                            Copiar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {receiveState.text && (
                  <div className="mt-4 rounded-xl bg-neutral-900 p-3 ring-1 ring-neutral-800">
                    <button
                      onClick={() => setReceiveTextOpen((prev) => !prev)}
                      className="w-full rounded-lg bg-neutral-800 px-3 py-2 text-left text-sm font-medium text-neutral-100 hover:bg-neutral-700"
                    >
                      {receiveTextOpen ? "Ocultar texto" : "Mostrar texto"}
                    </button>

                    {receiveTextOpen && (
                      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-neutral-950 p-3 text-sm text-neutral-100 ring-1 ring-neutral-800">
                        {receiveState.text}
                      </pre>
                    )}

                    <button
                      className="mt-3 rounded-xl bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-950"
                      onClick={() => void copyToClipboard(receiveState.text ?? "")}
                    >
                      Copiar texto
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        <footer className="mt-8 text-center text-xs text-neutral-500">
          ClipCode | MVP PRO | Sin cuentas | Expira automatico
        </footer>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-neutral-900 px-4 py-2 text-sm text-neutral-100 shadow-lg ring-1 ring-neutral-700">
          {toast}
        </div>
      )}
    </main>
  );
}
