"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import clsx from "clsx";
import { Space_Grotesk } from "next/font/google";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

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
const DEBUG_TRACE = process.env.NODE_ENV !== "production";

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

function normalizeNumericCode(value: string, maxLength: number): string {
  return value.replace(/\D/g, "").slice(0, maxLength);
}

function normalizeManualCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 5);
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

function inferPlatformName(): string {
  if (typeof navigator === "undefined") return "";
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string; mobile?: boolean };
    }
  ).userAgentData;
  const platformRaw = String(uaData?.platform ?? navigator.platform ?? "").toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platformRaw.includes("iphone") || userAgent.includes("iphone")) return "iPhone";
  if (platformRaw.includes("ipad") || userAgent.includes("ipad")) return "iPad";
  if (
    userAgent.includes("macintosh") &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1
  ) {
    return "iPad";
  }
  if (platformRaw.includes("android") || userAgent.includes("android")) return "Android";
  if (userAgent.includes("cros")) return "ChromeOS";
  if (platformRaw.includes("mac")) return "Mac";
  if (platformRaw.includes("win")) return "Windows";
  if (platformRaw.includes("linux")) return "Linux";
  if (uaData?.mobile) return "Movil";
  return "";
}

function inferBrowserName(): string {
  if (typeof navigator === "undefined") return "";
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { brands?: Array<{ brand?: string; version?: string }> };
    }
  ).userAgentData;
  const brands = (uaData?.brands ?? [])
    .map((entry) => String(entry?.brand ?? "").toLowerCase())
    .filter(Boolean);
  const ua = navigator.userAgent.toLowerCase();

  if (brands.some((brand) => brand.includes("edge"))) return "Edge";
  if (brands.some((brand) => brand.includes("opera"))) return "Opera";
  if (brands.some((brand) => brand.includes("firefox"))) return "Firefox";
  if (brands.some((brand) => brand.includes("safari"))) return "Safari";
  if (brands.some((brand) => brand.includes("chrome"))) return "Chrome";

  if (ua.includes("edgios/") || ua.includes("edg/")) return "Edge";
  if (ua.includes("opt/") || ua.includes("opr/") || ua.includes("opera")) return "Opera";
  if (ua.includes("firefox/") || ua.includes("fxios/")) return "Firefox";
  if (ua.includes("crios/") || ua.includes("chrome/")) return "Chrome";
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("safari/") && !ua.includes("chrome/") && !ua.includes("crios/")) {
    return "Safari";
  }
  return "";
}

function inferDeviceBrand(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent.toLowerCase();
  const platformName = inferPlatformName();

  if (platformName === "iPhone" || platformName === "iPad" || platformName === "Mac") {
    return "Apple";
  }
  if (ua.includes("samsung")) return "Samsung";
  if (ua.includes("huawei") || ua.includes("honor")) return "Huawei";
  if (ua.includes("xiaomi") || ua.includes("redmi") || ua.includes("miui")) return "Xiaomi";
  if (ua.includes("oneplus")) return "OnePlus";
  if (ua.includes("motorola") || ua.includes("moto")) return "Motorola";
  if (ua.includes("pixel")) return "Google";
  if (ua.includes("nokia")) return "Nokia";
  if (ua.includes("oppo")) return "OPPO";
  if (ua.includes("vivo")) return "vivo";
  if (ua.includes("realme")) return "realme";
  if (ua.includes("lenovo")) return "Lenovo";
  if (ua.includes("sony")) return "Sony";
  if (ua.includes("asus")) return "ASUS";
  if (ua.includes("acer")) return "Acer";
  if (ua.includes("msi")) return "MSI";
  if (ua.includes("dell")) return "Dell";
  if (ua.includes("hp") || ua.includes("hewlett-packard")) return "HP";
  if (ua.includes("thinkpad")) return "Lenovo";
  return "";
}

function fallbackDeviceLabel(deviceId: string): string {
  const shortId = deviceId.slice(-4).toUpperCase();
  const brandName = inferDeviceBrand();
  const platformName = inferPlatformName();
  const browserName = inferBrowserName();
  const labelBase = [brandName, platformName, browserName].filter(Boolean).join(" - ");
  const labelWithId = [labelBase || "Dispositivo", shortId].filter(Boolean).join(" ");
  return normalizeDeviceLabel(labelWithId || "Mi dispositivo");
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

function debugTrace(event: string, details?: Record<string, unknown>) {
  if (!DEBUG_TRACE || typeof window === "undefined") return;
  console.info("[clipcode][ui]", event, details ?? {});
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

    const storedLabel = normalizeDeviceLabel(localStorage.getItem(DEVICE_LABEL_STORAGE_KEY));
    const looksGenericStoredLabel = /^dispositivo\b/i.test(storedLabel);
    const resolvedLabel =
      !storedLabel || looksGenericStoredLabel
        ? fallbackDeviceLabel(resolvedDeviceId)
        : storedLabel;
    localStorage.setItem(DEVICE_LABEL_STORAGE_KEY, resolvedLabel);
    setDeviceLabel(resolvedLabel);
    debugTrace("device:init", {
      resolvedDeviceId,
      resolvedLabel,
      hadStoredDeviceId: Boolean(stored),
      hadStoredLabel: Boolean(storedLabel),
    });

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
    const code = normalizeManualCode(String(codeRaw ?? codeInput));

    if (code.length < 3) {
      setReceiveState({
        status: "error",
        message: "Ingresa un codigo de 3 a 5 digitos.",
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
      debugTrace("share:request", {
        linksCount: links.length,
        hasText: Boolean(textValue),
        ttlSeconds,
        senderDeviceId: deviceId || null,
      });
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
        nearbyQueued?: boolean;
        nearbyReason?: string;
        error?: string;
      };
      debugTrace("share:response", {
        ok: res.ok,
        status: res.status,
        code: data.code ?? null,
        expiresIn: data.expiresIn ?? null,
        nearbyQueued: data.nearbyQueued ?? null,
        nearbyReason: data.nearbyReason ?? null,
        error: data.error ?? null,
      });

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

      if (deviceId && data.nearbyQueued === false) {
        const nearbyMessage =
          data.nearbyReason === "not_paired"
            ? "Codigo generado. Buscar cerca no activo: falta vincular dispositivos."
            : "Codigo generado. Buscar cerca no activo para este envio.";
        showToast(nearbyMessage);
      } else {
        showToast("Codigo generado");
      }

    } catch (error: unknown) {
      debugTrace("share:error", {
        error: error instanceof Error ? error.message : String(error),
      });
      setSendState({
        status: "error",
        message: "No se pudo conectar. Revisa tu servidor.",
      });
    }
  }

  function onCodeChange(value: string) {
    const cleaned = normalizeManualCode(value);
    setCodeInput(cleaned);

    if (cleaned.length === 5) {
      void handleFetch(cleaned);
    }
  }

  function onPairCodeChange(value: string) {
    setPairCodeInput(normalizeNumericCode(value, 6));
  }

  async function handleCreatePairCode() {
    if (!deviceId) {
      showToast("No se pudo inicializar el dispositivo.");
      return;
    }

    try {
      debugTrace("pair:create:request", {
        receiverDeviceId: deviceId,
        receiverDeviceLabel: deviceLabel || null,
      });
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
      debugTrace("pair:create:response", {
        ok: res.ok,
        status: res.status,
        pairCode: data.pairCode ?? null,
        expiresIn: data.expiresIn ?? null,
        error: data.error ?? null,
      });

      if (!res.ok) {
        showToast(data.error ?? "No se pudo crear el código de sincronización.");
        return;
      }

      setPairingCode({
        code: String(data.pairCode ?? ""),
        expiresIn: Number(data.expiresIn ?? 600),
        createdAt: Date.now(),
      });
      showToast("Código de sincronización creado");
    } catch (error: unknown) {
      debugTrace("pair:create:error", {
        error: error instanceof Error ? error.message : String(error),
      });
      showToast("No se pudo crear el código de sincronización.");
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

    const normalizedPairCode = normalizeNumericCode(pairCodeInput, 6);
    if (normalizedPairCode.length !== 6) {
      setPairState({
        status: "error",
        message: "Ingresa el código de sincronización completo (6 dígitos).",
      });
      return;
    }

    setPairState({ status: "linking" });

    try {
      debugTrace("pair:confirm:request", {
        pairCode: normalizedPairCode,
        senderDeviceId: deviceId,
        senderDeviceLabel: deviceLabel || null,
      });
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
      debugTrace("pair:confirm:response", {
        ok: res.ok,
        status: res.status,
        linked: Boolean(data.linked),
        receiverDeviceId: data.receiverDeviceId ?? null,
        error: data.error ?? null,
      });

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
    } catch (error: unknown) {
      debugTrace("pair:confirm:error", {
        error: error instanceof Error ? error.message : String(error),
      });
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
    item?: {
      messageId?: string;
      code?: string;
      links: string[];
      text?: string;
      senderDeviceLabel?: string;
    };
  }> {
    debugTrace("nearby:poll:request", {
      receiverDeviceId: deviceId || null,
    });
    const res = await fetch(
      `/api/nearby/poll?receiverDeviceId=${encodeURIComponent(deviceId)}`
    );

    const data = (await res.json()) as {
      found?: boolean;
      item?: {
        messageId?: string;
        code?: string;
        links?: string[];
        text?: string;
        senderDeviceLabel?: string;
      };
      error?: string;
    };
    debugTrace("nearby:poll:response", {
      ok: res.ok,
      status: res.status,
      found: Boolean(data.found),
      hasItem: Boolean(data.item),
      error: data.error ?? null,
    });

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
    const messageIdValue = String(data.item.messageId ?? "").trim();
    const codeValue = String(data.item.code ?? "").trim().toUpperCase();
    const senderDeviceLabel = normalizeDeviceLabel(data.item.senderDeviceLabel);

    return {
      found: true,
      item: {
        messageId: messageIdValue || undefined,
        code: codeValue || undefined,
        links,
        text: textValue || undefined,
        senderDeviceLabel: senderDeviceLabel || undefined,
      },
    };
  }

  async function ackNearbyItem(messageId: string): Promise<void> {
    if (!deviceId || !messageId) return;
    const res = await fetch("/api/nearby/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receiverDeviceId: deviceId,
        messageId,
      }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      consumed?: boolean;
      error?: string;
    };
    debugTrace("nearby:ack:response", {
      ok: res.ok,
      status: res.status,
      consumed: Boolean(data.consumed),
      error: data.error ?? null,
    });

    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? "Error acknowledging nearby item");
    }
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
    debugTrace("nearby:search:start", {
      receiverDeviceId: deviceId,
    });

    const startedAt = Date.now();
    const timeoutMs = 30_000;
    const initialIntervalMs = 900;
    const maxIntervalMs = 4_500;
    let attempts = 0;

    const nextDelayMs = (): number => {
      const base = Math.min(
        maxIntervalMs,
        Math.floor(initialIntervalMs * Math.pow(1.6, attempts))
      );
      attempts += 1;
      const jitter = Math.floor(Math.random() * 350);
      return base + jitter;
    };

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
          debugTrace("nearby:search:found", {
            messageId: result.item.messageId ?? null,
            code: result.item.code ?? null,
            linksCount: result.item.links.length,
            hasText: Boolean(result.item.text),
          });
          if (result.item.messageId) {
            try {
              await ackNearbyItem(result.item.messageId);
            } catch (error: unknown) {
              debugTrace("nearby:ack:error", {
                error: error instanceof Error ? error.message : String(error),
                messageId: result.item.messageId,
              });
            }
          }
          showToast("Contenido encontrado");
          return;
        }
      } catch (error: unknown) {
        debugTrace("nearby:search:error", {
          error: error instanceof Error ? error.message : String(error),
        });
        setNearbyState({
          status: "error",
          message: "No se pudo completar la busqueda.",
        });
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        debugTrace("nearby:search:timeout", {
          timeoutMs,
        });
        setNearbyState({ status: "empty" });
        return;
      }

      const delayMs = nextDelayMs();
      debugTrace("nearby:search:retry", {
        attempts,
        delayMs,
      });
      nearbyPollTimerRef.current = window.setTimeout(() => {
        void tick();
      }, delayMs);
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

      const normalized = normalizeManualCode(codeFromUrl);
      setTab("receive");
      setCodeInput(normalized);
      if (normalized.length >= 3) {
        void handleFetch(normalized);
      }
      window.history.replaceState(null, "", "/");
      return;
    }

    const pairFromUrl = params.get("pair");
    if (pairFromUrl) {
      didAutoProcessRef.current = true;
      const normalizedPair = normalizeNumericCode(pairFromUrl, 6);
      setTab("send");
      setPairCodeInput(normalizedPair);
      showToast("Código de sincronización detectado");
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
    if (typeof window === "undefined") return `/open?pair=${pairingCode.code}`;
    return `${window.location.origin}/open?pair=${pairingCode.code}`;
  }, [pairingCode]);

  return (
    <main
      className={clsx(
        spaceGrotesk.variable,
        "relative min-h-screen overflow-x-hidden bg-[#06070b] font-[family-name:var(--font-space-grotesk)] text-slate-100"
      )}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-20 -top-28 h-72 w-72 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute -right-24 top-40 h-80 w-80 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-fuchsia-500/15 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
        <header className="mb-7">
          <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200 backdrop-blur">
            Transferencia rapida entre dispositivos
          </div>
          <h1 className="mt-3 text-center text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            ClipEc
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-slate-300 sm:text-base">
            Comparte links y texto entre dispositivos con un codigo. Sin cuenta.
          </p>
          <div className="mt-4">
            <a
              href="https://github.com/lufergio/clipcode/releases/download/android-v1.0.0/app-clipec.apk"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110"
            >
              Descargar APK
            </a>
          </div>
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/20 backdrop-blur">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
              Nombre de este dispositivo
            </label>
            <input
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(normalizeDeviceLabel(event.target.value))}
              onBlur={() => persistDeviceLabel(deviceLabel)}
              placeholder="Ej: TV Sala, iPhone Luis"
              className="w-full rounded-xl border border-white/10 bg-[#0e1119] px-3 py-2.5 text-sm outline-none transition focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
            />
          </div>
        </header>

        <div className="mb-6 flex rounded-2xl border border-white/10 bg-white/[0.04] p-1 backdrop-blur">
          <button
            className={clsx(
              "flex-1 rounded-xl px-4 py-3 text-base font-semibold transition",
              tab === "send"
                ? "bg-gradient-to-r from-cyan-300 to-blue-300 text-slate-950"
                : "text-slate-200 hover:bg-white/10"
            )}
            onClick={() => setTab("send")}
          >
            Enviar
          </button>
          <button
            className={clsx(
              "flex-1 rounded-xl px-4 py-3 text-base font-semibold transition",
              tab === "receive"
                ? "bg-gradient-to-r from-cyan-300 to-blue-300 text-slate-950"
                : "text-slate-200 hover:bg-white/10"
            )}
            onClick={() => setTab("receive")}
          >
            Recibir
          </button>
        </div>

        {tab === "send" && (
          <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/20 backdrop-blur sm:p-6">
            <h2 className="text-xl font-semibold text-white">Enviar contenido</h2>
            <p className="mt-1 text-sm text-slate-300">
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
                      "w-full rounded-xl border px-4 py-3 text-base outline-none transition",
                      invalid
                        ? "border-rose-500/90 bg-rose-500/10 focus:ring-2 focus:ring-rose-300/30"
                        : "border-white/10 bg-[#0d1018] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
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
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/15 disabled:opacity-60"
              >
                Agregar link
              </button>

              <button
                onClick={() => setShowTextComposer((prev) => !prev)}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/15"
              >
                {showTextComposer ? "Ocultar texto" : "Agregar texto"}
              </button>
            </div>

            {showTextComposer && (
              <div className="mt-4">
                <label className="mb-2 block text-sm font-medium text-slate-200">
                  Texto (opcional)
                </label>
                <textarea
                  ref={sendTextareaRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className="h-28 w-full resize-none rounded-xl border border-white/10 bg-[#0d1018] p-3 text-sm outline-none transition focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
                  placeholder="Notas, codigo, instrucciones..."
                />
              </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-200">
                  Expiracion
                </label>
                <select
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(Number(event.target.value))}
                  className="w-full rounded-xl border border-white/10 bg-[#0d1018] px-4 py-3 text-base outline-none transition focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
                >
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-200">
                  Código de sincronización (enviar a dispositivo vinculado)
                </label>
                <div className="flex gap-2">
                  <input
                    value={pairCodeInput}
                    onChange={(event) => onPairCodeChange(event.target.value)}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="123456"
                    className="w-full rounded-xl border border-white/10 bg-[#0d1018] px-4 py-3 text-center text-lg tracking-widest outline-none transition focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
                  />
                  <button
                    onClick={() => void handleConfirmPair()}
                    disabled={pairState.status === "linking"}
                    className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                  >
                    {pairState.status === "linking" ? "Vinculando..." : "Vincular"}
                  </button>
                </div>
              </div>
            </div>

            {pairState.status === "linked" && (
              <div className="mt-3 rounded-xl border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                <div>
                  Vinculado con{" "}
                  <span className="font-semibold">
                    {pairState.receiverDeviceLabel || "dispositivo remoto"}
                  </span>
                  . Buscar cerca disponible para este par.
                </div>
                <button
                  onClick={handleUnlinkPair}
                  className="mt-2 rounded-lg border border-emerald-300/30 bg-emerald-400/20 px-3 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-400/30"
                >
                  Desvincular
                </button>
              </div>
            )}
            {pairState.status === "error" && (
              <div className="mt-3 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-100">
                {pairState.message}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={() => void handleGenerate()}
                disabled={sendState.status === "loading"}
                className="rounded-xl bg-gradient-to-r from-cyan-300 via-sky-300 to-blue-300 px-5 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 disabled:opacity-60"
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
                className="rounded-xl border border-white/10 bg-white/10 px-5 py-3 text-base font-medium text-slate-100 transition hover:bg-white/15"
              >
                Nuevo
              </button>
            </div>

            <div className="mt-2 text-xs text-slate-400">
              {cleanedLinks.length} links listos / {MAX_LINKS}
            </div>

            {sendState.status === "error" && (
              <div className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-100">
                {sendState.message}
              </div>
            )}

            {sendState.status === "success" && (
              <div className="mt-6 rounded-2xl border border-white/10 bg-[#0b0f17] p-4">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-5xl font-bold tracking-widest">{sendState.code}</div>
                  <div className="text-sm text-slate-300">Expira en: {expiresLabel}</div>

                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950"
                      onClick={() => void copyToClipboard(sendState.code)}
                    >
                      Copiar codigo
                    </button>
                    <button
                      className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-white/15"
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
          <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/20 backdrop-blur sm:p-6">
            <h2 className="text-xl font-semibold text-white">Recibir contenido</h2>
            <p className="mt-1 text-sm text-slate-300">
              Puedes usar codigo manual o Buscar cerca con pairing.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <button
                onClick={() => void handleCreatePairCode()}
                className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-5 py-3 text-base font-semibold text-slate-950 transition hover:brightness-110"
              >
                Vincular con código
              </button>
              <button
                onClick={() => void handleNearbySearch()}
                disabled={nearbyState.status === "searching"}
                className="rounded-xl border border-cyan-300/30 bg-cyan-400/20 px-5 py-3 text-base font-semibold text-cyan-100 transition hover:bg-cyan-400/30 disabled:opacity-60"
              >
                {nearbyState.status === "searching" ? "Buscando..." : "Buscar cerca"}
              </button>
            </div>

            {pairingCode && (
              <div className="mt-4 rounded-2xl border border-white/10 bg-[#0b0f17] p-4">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-sm text-slate-300">Código de sincronización</div>
                  <div className="text-4xl font-bold tracking-widest">{pairingCode.code}</div>
                  <div className="text-xs text-slate-400">
                    Dispositivo: {deviceLabel || "Mi dispositivo"}
                  </div>
                  <div className="text-xs text-slate-400">
                    Expira en {Math.ceil(pairingCode.expiresIn / 60)} min
                  </div>
                  <div className="rounded-2xl bg-white p-3">
                    <QRCodeCanvas value={pairLink || pairingCode.code} size={180} />
                  </div>
                  <button
                    onClick={() => void copyToClipboard(pairingCode.code)}
                    className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950"
                  >
                    Copiar código de sincronización
                  </button>
                </div>
              </div>
            )}

            {nearbyState.status === "empty" && (
              <div className="mt-4 rounded-xl border border-amber-300/40 bg-amber-300/10 p-3 text-sm text-amber-100">
                No se encontro nada. Verifica que hayas enviado a este dispositivo o escribe
                el codigo manual.
              </div>
            )}
            {nearbyState.status === "error" && (
              <div className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-100">
                {nearbyState.message}
              </div>
            )}

            <div className="mt-6 rounded-xl border border-white/10 bg-[#0b0f17] p-4">
              <h3 className="text-sm font-semibold text-slate-200">Modo manual por codigo</h3>
              <input
                ref={receiveInputRef}
                value={codeInput}
                onChange={(event) => onCodeChange(event.target.value)}
                className="mt-3 w-full rounded-xl border border-white/10 bg-[#101522] p-3 text-center text-2xl tracking-widest outline-none transition focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-200/20"
                placeholder="12345"
                inputMode="numeric"
                pattern="[0-9]*"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void handleFetch()}
                  disabled={receiveState.status === "loading"}
                  className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                >
                  {receiveState.status === "loading" ? "Buscando..." : "Recibir"}
                </button>
                <button
                  onClick={() => {
                    setCodeInput("");
                    setReceiveState({ status: "idle" });
                  }}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/15"
                >
                  Limpiar
                </button>
              </div>
            </div>

            {receiveState.status === "error" && (
              <div className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-100">
                {receiveState.message}
              </div>
            )}

            {receiveState.status === "success" && (
              <div className="mt-6 rounded-2xl border border-white/10 bg-[#0b0f17] p-4">
                <div className="mb-3 text-sm text-slate-300">
                  Codigo: <span className="font-semibold text-slate-100">{receiveState.code}</span>
                </div>
                {receiveState.sourceDeviceLabel && (
                  <div className="mb-3 text-sm text-slate-300">
                    Enviado desde:{" "}
                    <span className="font-semibold text-slate-100">
                      {receiveState.sourceDeviceLabel}
                    </span>
                  </div>
                )}

                {!!receiveState.links.length && (
                  <div className="space-y-3">
                    {receiveState.links.map((link, index) => (
                      <div
                        key={`${link}-${index}`}
                        className="rounded-xl border border-white/10 bg-[#101522] p-3"
                      >
                        <div className="text-sm text-slate-200">{shortenLink(link)}</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl border border-cyan-300/30 bg-cyan-400/20 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-400/30"
                          >
                            Abrir
                          </a>
                          <button
                            onClick={() => void copyToClipboard(link)}
                            className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950"
                          >
                            Copiar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {receiveState.text && (
                  <div className="mt-4 rounded-xl border border-white/10 bg-[#101522] p-3">
                    <button
                      onClick={() => setReceiveTextOpen((prev) => !prev)}
                      className="w-full rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-left text-sm font-medium text-slate-100 transition hover:bg-white/15"
                    >
                      {receiveTextOpen ? "Ocultar texto" : "Mostrar texto"}
                    </button>

                    {receiveTextOpen && (
                      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-[#0b0f17] p-3 text-sm text-slate-100">
                        {receiveState.text}
                      </pre>
                    )}

                    <button
                      className="mt-3 rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-sm font-semibold text-slate-950"
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

        <footer className="mt-8 text-center text-xs text-slate-500">
          ClipEc | MVP PRO | Sin cuentas | Expira automatico
        </footer>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-white/15 bg-[#0d111a]/95 px-4 py-2 text-sm text-slate-100 shadow-lg shadow-black/40 backdrop-blur">
          {toast}
        </div>
      )}
    </main>
  );
}
