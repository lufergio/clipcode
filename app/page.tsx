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
  | { status: "waiting" }
  | { status: "linking" }
  | { status: "linked"; receiverDeviceId: string; receiverDeviceLabel?: string }
  | { status: "error"; message: string };

type NearbyState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "empty" }
  | { status: "error"; message: string };

type ReceivedHistoryItem = {
  id: string;
  code: string;
  links: string[];
  text?: string;
  sourceDeviceLabel?: string;
  receivedAt: number;
  repeatCount: number;
};

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

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"'\(\)]+/gi;
  const matches = text.match(urlRegex) || [];
  return Array.from(new Set(matches.map((url) => url.trim())));
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

function PasteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M9 3h6l1 2h3v16H5V5h3l1-2Zm1.2 2-.5 1H7v13h10V6h-2.7l-.5-1h-3.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v9H8V9Zm6 0h2v9h-2V9ZM6 9h12l-1 11H7L6 9Z"
        fill="currentColor"
      />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 3h11v14H8V3Zm2 2v10h7V5h-7ZM5 7H3v14h11v-2H5V7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M4 5h16v2h-7v12h-2V7H4V5Zm-1 6h8v2H3v-2Zm0 4h8v2H3v-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function HomePage() {
  const [tab, setTab] = useState<"send" | "receive">("send");

  const [linkInputs, setLinkInputs] = useState<string[]>(["", "", ""]);
  const [showTextComposer, setShowTextComposer] = useState(false);
  const [text, setText] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(3600);
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });

  const [codeInput, setCodeInput] = useState("");
  const [receiveState, setReceiveState] = useState<ReceiveState>({ status: "idle" });
  const [receiveTextOpen, setReceiveTextOpen] = useState(true);
  const [receiveHistory, setReceiveHistory] = useState<ReceivedHistoryItem[]>([]);

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
  const [showApkDownloadButton, setShowApkDownloadButton] = useState(false);
  const [pendingAutoPairCode, setPendingAutoPairCode] = useState<string | null>(null);
  const [isUnlinkingPair, setIsUnlinkingPair] = useState(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const nearbyPollTimerRef = useRef<number | null>(null);
  const pairStatusPollTimerRef = useRef<number | null>(null);
  const didAutoProcessRef = useRef(false);

  const sendTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const receiveInputRef = useRef<HTMLInputElement | null>(null);

  const [rememberPairing, setRememberPairing] = useState(true);
  const [isEditingDeviceLabel, setIsEditingDeviceLabel] = useState(false);
  const [activeQrModal, setActiveQrModal] = useState<{
    value: string;
    title: string;
    subtitle?: string;
    pinCode?: string;
  } | null>(null);
  const [qrCountdown, setQrCountdown] = useState<number>(10);
  const qrTimerRef = useRef<number | null>(null);

  function openQrModal(params: {
    value: string;
    title: string;
    subtitle?: string;
    pinCode?: string;
  }) {
    if (qrTimerRef.current) {
      window.clearInterval(qrTimerRef.current);
    }
    setActiveQrModal(params);
    setQrCountdown(10);

    qrTimerRef.current = window.setInterval(() => {
      setQrCountdown((prev) => {
        if (prev <= 1) {
          if (qrTimerRef.current) window.clearInterval(qrTimerRef.current);
          setActiveQrModal(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function closeQrModal() {
    if (qrTimerRef.current) {
      window.clearInterval(qrTimerRef.current);
      qrTimerRef.current = null;
    }
    setActiveQrModal(null);
  }

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

  function clearPairStatusPollTimer() {
    if (pairStatusPollTimerRef.current) {
      window.clearTimeout(pairStatusPollTimerRef.current);
      pairStatusPollTimerRef.current = null;
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
    if (deviceId) {
      void fetch("/api/device/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceLabel: resolved }),
      });
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

    // Verificar siempre al recargar/iniciar si la pareja actualizó su nombre o estado
    void fetchPairStatusOnce(resolvedDeviceId).then((linkedInfo) => {
      if (!linkedInfo) {
        if (!pairedReceiver) setPairState({ status: "idle" });
        return;
      }
      savePairedReceiverInfo(linkedInfo);
      setPairState({
        status: "linked",
        receiverDeviceId: linkedInfo.receiverDeviceId,
        receiverDeviceLabel: linkedInfo.receiverDeviceLabel,
      });
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const fromAppFlag = String(
      params.get("fromApp") ?? params.get("app") ?? ""
    ).toLowerCase();
    const hasExplicitFromApp =
      fromAppFlag === "1" || fromAppFlag === "true" || fromAppFlag === "yes";

    const ua = navigator.userAgent.toLowerCase();
    const isAndroidWebView =
      /\bwv\b/.test(ua) ||
      (ua.includes("android") &&
        ua.includes("version/4.0") &&
        ua.includes("chrome/") &&
        ua.includes("mobile safari/"));
    const isInAppBrowser =
      ua.includes("fb_iab") ||
      ua.includes("instagram") ||
      ua.includes("line/") ||
      ua.includes("micromessenger");
    const cameFromAndroidApp = document.referrer.startsWith("android-app://");

    const isAppContext =
      hasExplicitFromApp || isAndroidWebView || isInAppBrowser || cameFromAndroidApp;

    setShowApkDownloadButton(!isAppContext);
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
      appendReceivedHistory({
        code: String(data?.code ?? code),
        links,
        text: receivedText || undefined,
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

  const detectedLinks = useMemo(() => extractUrls(text), [text]);

  async function handleGenerate(payloadOverride?: { links: string[]; text?: string }) {
    const textValue = String((payloadOverride ? payloadOverride.text : text) ?? "").trim();
    const manualLinks = payloadOverride ? payloadOverride.links : cleanedLinks;
    const autoExtracted = extractUrls(textValue);
    const combinedLinks = Array.from(
      new Set([...manualLinks.map((v) => v.trim()).filter(Boolean), ...autoExtracted])
    );

    if (!combinedLinks.length && !textValue) {
      setSendState({
        status: "error",
        message: "Escribe o pega texto, código o enlaces para compartir.",
      });
      return;
    }

    if (combinedLinks.length > MAX_LINKS) {
      setSendState({
        status: "error",
        message: `Máximo ${MAX_LINKS} enlaces por envío.`,
      });
      return;
    }

    setSendState({ status: "loading" });

    try {
      debugTrace("share:request", {
        linksCount: combinedLinks.length,
        hasText: Boolean(textValue),
        ttlSeconds,
        senderDeviceId: deviceId || null,
      });
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: combinedLinks,
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

      if (!res.ok) {
        setSendState({
          status: "error",
          message: data?.error ?? "Error al generar el código.",
        });
        return;
      }

      setSendState({
        status: "success",
        code: String(data.code ?? ""),
        expiresIn: Number(data.expiresIn ?? ttlSeconds),
        createdAt: Date.now(),
      });

      if (deviceId && data.nearbyQueued === false) {
        const nearbyMessage =
          data.nearbyReason === "not_paired"
            ? "Código generado. Vinculación no activa en el receptor."
            : "Código generado.";
        showToast(nearbyMessage);
      } else {
        showToast("¡Código generado con éxito!");
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

      const pairCodeStr = String(data.pairCode ?? "");
      setPairingCode({
        code: pairCodeStr,
        expiresIn: Number(data.expiresIn ?? 600),
        createdAt: Date.now(),
      });
      setPairState({ status: "waiting" });
      startPairStatusPolling(Number(data.expiresIn ?? 600));

      const generatedPairLink =
        typeof window !== "undefined"
          ? `${window.location.origin}/open?pair=${pairCodeStr}&auto=1`
          : `/open?pair=${pairCodeStr}&auto=1`;

      openQrModal({
        value: generatedPairLink,
        title: "Escanea para Vincular",
        pinCode: pairCodeStr,
      });
      showToast("Código de sincronización creado");
    } catch (error: unknown) {
      debugTrace("pair:create:error", {
        error: error instanceof Error ? error.message : String(error),
      });
      showToast("No se pudo crear el código de sincronización.");
    }
  }

  async function handleConfirmPair(pairCodeOverride?: string) {
    if (!deviceId) {
      setPairState({
        status: "error",
        message: "No se pudo inicializar el dispositivo.",
      });
      return;
    }

    const normalizedPairCode = normalizeNumericCode(
      pairCodeOverride ?? pairCodeInput,
      6
    );
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
      clearPairStatusPollTimer();
      setPairingCode(null);
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

  async function handleUnlinkPair() {
    if (!deviceId) {
      showToast("No se pudo inicializar el dispositivo.");
      return;
    }

    setIsUnlinkingPair(true);
    try {
      clearPairStatusPollTimer();
      await fetch("/api/pair/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderDeviceId: deviceId,
          receiverDeviceId:
            pairState.status === "linked" ? pairState.receiverDeviceId : undefined,
        }),
      });
      localStorage.removeItem(PAIRED_RECEIVER_STORAGE_KEY);
      setPairState({ status: "idle" });
      setPairingCode(null);
      showToast("Vinculacion eliminada");
    } catch {
      showToast("No se pudo desvincular.");
    } finally {
      setIsUnlinkingPair(false);
    }
  }

  async function pasteTextComposer() {
    try {
      const raw = await navigator.clipboard.readText();
      const next = String(raw ?? "");
      if (!next.trim()) {
        showToast("Portapapeles vacio");
        return;
      }
      setText(next);
      setShowTextComposer(true);
      showToast("Texto pegado");
    } catch {
      showToast("No se pudo pegar");
    }
  }

  function clearTextComposer() {
    setText("");
  }

  function appendReceivedHistory(item: {
    code: string;
    links: string[];
    text?: string;
    sourceDeviceLabel?: string;
  }) {
    const normalizedCode = String(item.code ?? "").trim().toUpperCase() || "PAIR";
    const normalizedLinks = Array.isArray(item.links)
      ? item.links.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    const normalizedText = String(item.text ?? "").trim();
    if (!normalizedLinks.length && !normalizedText) return;

    const entry: ReceivedHistoryItem = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `rx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      code: normalizedCode,
      links: normalizedLinks,
      text: normalizedText || undefined,
      sourceDeviceLabel: normalizeDeviceLabel(item.sourceDeviceLabel) || undefined,
      receivedAt: Date.now(),
      repeatCount: 1,
    };

    const signature = JSON.stringify({
      links: normalizedLinks,
      text: normalizedText || "",
      sourceDeviceLabel: entry.sourceDeviceLabel || "",
    });

    setReceiveHistory((prev) => {
      const matchIndex = prev.findIndex((historyItem) => {
        const historySignature = JSON.stringify({
          links: historyItem.links,
          text: historyItem.text || "",
          sourceDeviceLabel: historyItem.sourceDeviceLabel || "",
        });
        return historySignature === signature;
      });

      if (matchIndex === -1) {
        return [entry, ...prev].slice(0, 40);
      }

      const existing = prev[matchIndex];
      const merged: ReceivedHistoryItem = {
        ...existing,
        code: normalizedCode,
        receivedAt: Date.now(),
        repeatCount: (existing.repeatCount || 1) + 1,
      };
      const next = prev.filter((_, index) => index !== matchIndex);
      return [merged, ...next].slice(0, 40);
    });
  }

  async function pasteLinkAt(index: number) {
    try {
      const raw = await navigator.clipboard.readText();
      const nextValue = String(raw ?? "").trim();
      if (!nextValue) {
        showToast("Portapapeles vacio");
        return;
      }
      const next = [...linkInputs];
      next[index] = nextValue;
      setLinkInputs(next);
      showToast("Link pegado");
    } catch {
      showToast("No se pudo pegar");
    }
  }

  function clearLinkAt(index: number) {
    const next = [...linkInputs];
    next[index] = "";
    setLinkInputs(next);
  }

  async function fetchPairStatusOnce(targetDeviceId: string): Promise<PairedReceiverInfo | null> {
    const normalizedDeviceId = normalizeDeviceId(targetDeviceId);
    if (!normalizedDeviceId) return null;

    const res = await fetch(
      `/api/pair/status?deviceId=${encodeURIComponent(normalizedDeviceId)}`
    );
    const data = (await res.json()) as {
      linked?: boolean;
      receiverDeviceId?: string;
      receiverDeviceLabel?: string;
    };
    if (!res.ok || !data.linked || !data.receiverDeviceId) return null;

    const receiverDeviceId = normalizeDeviceId(data.receiverDeviceId);
    if (!receiverDeviceId) return null;

    return {
      receiverDeviceId,
      receiverDeviceLabel: normalizeDeviceLabel(data.receiverDeviceLabel) || undefined,
    };
  }

  function startPairStatusPolling(expiresInSeconds: number) {
    if (!deviceId) return;
    clearPairStatusPollTimer();

    const startedAt = Date.now();
    const timeoutMs = Math.max(10_000, expiresInSeconds * 1000);

    const tick = async () => {
      try {
        const linkedInfo = await fetchPairStatusOnce(deviceId);
        if (linkedInfo) {
          savePairedReceiverInfo(linkedInfo);
          setPairState({
            status: "linked",
            receiverDeviceId: linkedInfo.receiverDeviceId,
            receiverDeviceLabel: linkedInfo.receiverDeviceLabel,
          });
          setPairingCode(null);
          showToast("Dispositivo vinculado");
          return;
        }
      } catch {
        // silencioso: seguimos intentando hasta timeout.
      }

      if (Date.now() - startedAt >= timeoutMs) {
        setPairState({
          status: "error",
          message: "Tiempo de espera agotado. Genera un nuevo código.",
        });
        return;
      }

      pairStatusPollTimerRef.current = window.setTimeout(() => {
        void tick();
      }, 1200);
    };

    pairStatusPollTimerRef.current = window.setTimeout(() => {
      void tick();
    }, 500);
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
          appendReceivedHistory({
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
      if (normalizedPair.length === 6) {
        setPendingAutoPairCode(normalizedPair);
        showToast("Código detectado. Vinculando...");
      } else {
        showToast("Código de sincronización detectado");
      }
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
    if (!pendingAutoPairCode || !deviceId) return;
    void handleConfirmPair(pendingAutoPairCode);
    setPendingAutoPairCode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoPairCode, deviceId]);

  useEffect(() => {
    return () => {
      clearNearbyPollTimer();
      clearPairStatusPollTimer();
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
    if (typeof window === "undefined") return `/open?pair=${pairingCode.code}&auto=1`;
    return `${window.location.origin}/open?pair=${pairingCode.code}&auto=1`;
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

      <div className="relative mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {/* Header con Banner Unificado Integrado */}
        <header className="mb-6 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            ClipCode
          </h1>
          <p className="mt-1 text-xs font-medium text-cyan-400/90 sm:text-sm">
            Transferencia rápida entre dispositivos
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {showApkDownloadButton && (
              <a
                href="https://github.com/lufergio/clipcode/releases/download/android-v1.0.0/app-clipec.apk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-0.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
              >
                Descargar APK Android
              </a>
            )}

            <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 backdrop-blur">
              <span className="font-semibold text-slate-400">Dispositivo:</span>
              {isEditingDeviceLabel ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(normalizeDeviceLabel(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        persistDeviceLabel(deviceLabel);
                        setIsEditingDeviceLabel(false);
                        showToast("Nombre guardado");
                      }
                    }}
                    placeholder="Nombre"
                    autoFocus
                    className="w-28 rounded-lg border border-cyan-400/50 bg-[#131724] px-2 py-0.5 font-medium text-white outline-none focus:border-cyan-300 sm:w-36 text-xs"
                  />
                  <button
                    onClick={() => {
                      persistDeviceLabel(deviceLabel);
                      setIsEditingDeviceLabel(false);
                      showToast("Nombre guardado");
                    }}
                    className="rounded-md bg-gradient-to-r from-cyan-400 to-blue-400 px-2 py-0.5 text-[11px] font-bold text-slate-950 hover:brightness-110 transition shadow-sm"
                  >
                    Guardar
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-white">{deviceLabel || "Mi dispositivo"}</span>
                  <button
                    onClick={() => setIsEditingDeviceLabel(true)}
                    className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-white/20 transition"
                    title="Personalizar nombre"
                  >
                    ✏️ Editar
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Banner Unificado (ÚNICO LUGAR DONDE VIVE LA VINCULACIÓN Y DETALLES DE CÓDIGO) */}
          <div className="mt-4 mx-auto max-w-2xl rounded-2xl border border-cyan-400/30 bg-[#0c101b]/95 p-3 text-xs backdrop-blur shadow-xl shadow-cyan-950/30">
            {pairState.status === "linked" ? (
              /* Dispositivo Vinculado Activo */
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
                  <div className="flex items-center gap-2 text-emerald-300 font-semibold text-sm">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                    </span>
                    <span>Vinculado con: <strong className="text-white">{pairState.receiverDeviceLabel || "Dispositivo remoto"}</strong></span>
                  </div>
                  <button
                    onClick={() => void handleUnlinkPair()}
                    disabled={isUnlinkingPair}
                    className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-400/20 transition disabled:opacity-60"
                  >
                    {isUnlinkingPair ? "..." : "Desvincular"}
                  </button>
                </div>

                {/* Código de Clip informativo durante estado de vinculación */}
                {sendState.status === "success" && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-2 px-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md border border-cyan-400/40 bg-cyan-400/20 px-1.5 py-0.5 text-[10px] font-bold text-cyan-200 uppercase">
                        Informativo
                      </span>
                      <span className="text-slate-300">Código:</span>
                      <span className="font-mono text-base font-black tracking-widest text-cyan-300">
                        {sendState.code}
                      </span>
                      <span className="text-[10px] text-slate-400">({expiresLabel})</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => void copyToClipboard(sendState.code)}
                        className="rounded-lg bg-gradient-to-r from-cyan-300 to-blue-300 px-2 py-1 text-[11px] font-bold text-slate-950 hover:brightness-110 transition"
                      >
                        Copiar
                      </button>
                      <button
                        onClick={() => void copyToClipboard(shareLink)}
                        className="rounded-lg border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-white/15 transition"
                      >
                        Enlace
                      </button>
                      <button
                        onClick={() =>
                          openQrModal({
                            value: shareLink || sendState.code,
                            title: "Código QR de Clip",
                            subtitle: `Código: ${sendState.code}`,
                          })
                        }
                        className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/20 transition"
                      >
                        📱 QR (10s)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : sendState.status === "success" ? (
              /* Muestra el Código Generado directamente en el Banner */
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">Código de Clip:</span>
                  <span className="font-mono text-xl font-black tracking-widest text-cyan-300">
                    {sendState.code}
                  </span>
                  <span className="text-[10px] text-slate-400">({expiresLabel})</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void copyToClipboard(sendState.code)}
                    className="rounded-lg bg-gradient-to-r from-cyan-300 to-blue-300 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:brightness-110 transition"
                  >
                    Copiar
                  </button>
                  <button
                    onClick={() => void copyToClipboard(shareLink)}
                    className="rounded-lg border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-white/15 transition"
                  >
                    Enlace
                  </button>
                  <button
                    onClick={() =>
                      openQrModal({
                        value: shareLink || sendState.code,
                        title: "Código QR de Clip",
                        subtitle: `Código: ${sendState.code}`,
                      })
                    }
                    className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/20 transition"
                  >
                    📱 QR (10s)
                  </button>
                  <button
                    onClick={() => setSendState({ status: "idle" })}
                    className="ml-1 text-slate-400 hover:text-white transition text-sm font-bold"
                    title="Nuevo Envió"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              /* Proceso de Vinculación (Generar PIN / Ingresar PIN) */
              <div className="grid gap-3 sm:grid-cols-2 items-center divide-y sm:divide-y-0 sm:divide-x divide-white/10">
                {/* Botón 1: Generar PIN */}
                <div className="flex items-center justify-between gap-2 pr-0 sm:pr-2 pt-1 sm:pt-0">
                  <button
                    onClick={async () => {
                      await handleCreatePairCode();
                    }}
                    className="rounded-xl bg-gradient-to-r from-cyan-400 to-blue-400 px-3.5 py-1.5 text-xs font-bold text-slate-950 hover:brightness-110 transition shadow-md"
                  >
                    Generar PIN
                  </button>

                  {pairingCode ? (
                    <div className="flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-400/15 px-2.5 py-1 font-mono text-xs font-bold text-cyan-200">
                      <span>PIN:</span>
                      <span className="tracking-widest text-sm text-cyan-300 font-extrabold">{pairingCode.code}</span>
                      <button
                        onClick={() => void copyToClipboard(pairingCode.code)}
                        className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 p-1 text-cyan-200 hover:bg-cyan-400/25 hover:text-white transition active:scale-95"
                        title="Copiar PIN"
                      >
                        <CopyIcon />
                      </button>
                      <button
                        onClick={() => {
                          const pairLink =
                            typeof window !== "undefined"
                              ? `${window.location.origin}/open?pair=${pairingCode.code}&auto=1`
                              : `/open?pair=${pairingCode.code}&auto=1`;
                          openQrModal({
                            value: pairLink,
                            title: "Escanea para Vincular",
                            pinCode: pairingCode.code,
                          });
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/25 hover:text-white transition active:scale-95"
                        title="Abrir QR de nuevo"
                      >
                        <span>📱 QR</span>
                      </button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-400 italic">Dispositivo A</span>
                  )}
                </div>

                {/* Botón 2: Escribir PIN y Vincular */}
                <div className="flex items-center justify-between gap-1.5 pl-0 sm:pl-3 pt-2 sm:pt-0">
                  <div className="flex items-center gap-1.5 w-full">
                    <input
                      value={pairCodeInput}
                      onChange={(e) => onPairCodeChange(e.target.value)}
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="PIN (6 dígitos)"
                      className="w-full rounded-xl border border-white/10 bg-[#131724] px-2.5 py-1.5 text-center font-mono text-xs text-white placeholder:text-slate-500 outline-none focus:border-cyan-400 transition"
                    />
                    <button
                      onClick={() => void handleConfirmPair()}
                      disabled={pairCodeInput.length !== 6 || pairState.status === "linking"}
                      className={clsx(
                        "rounded-xl px-3 py-1.5 text-xs font-bold transition whitespace-nowrap",
                        pairCodeInput.length === 6
                          ? "bg-gradient-to-r from-emerald-400 to-teal-400 text-slate-950 shadow-lg shadow-emerald-500/20 animate-bounce cursor-pointer"
                          : "bg-white/10 text-slate-400 opacity-60 cursor-not-allowed"
                      )}
                    >
                      {pairState.status === "linking" ? "..." : "Vincular"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </header>

        <div className="mb-6 flex rounded-2xl border border-white/10 bg-white/[0.04] p-1 backdrop-blur">
          <button
            className={clsx(
              "flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition",
              tab === "send"
                ? "bg-gradient-to-r from-cyan-300 to-blue-300 text-slate-950 shadow-lg shadow-cyan-500/20"
                : "text-slate-300 hover:bg-white/10"
            )}
            onClick={() => setTab("send")}
          >
            Enviar / Crear Clip
          </button>
          <button
            className={clsx(
              "flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition",
              tab === "receive"
                ? "bg-gradient-to-r from-cyan-300 to-blue-300 text-slate-950 shadow-lg shadow-cyan-500/20"
                : "text-slate-300 hover:bg-white/10"
            )}
            onClick={() => setTab("receive")}
          >
            Recibir
          </button>
        </div>

        {tab === "send" && (
          <section className="space-y-6">
            {/* ShareText.io Style Editor Card */}
            <div className="rounded-3xl border border-white/10 bg-[#0d1017] shadow-2xl shadow-black/40 overflow-hidden backdrop-blur">
              {/* Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.03] px-4 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(text)}
                    disabled={!text.trim()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
                  >
                    <CopyIcon />
                    <span>Copiar Texto</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void pasteTextComposer()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
                  >
                    <PasteIcon />
                    <span>Pegar</span>
                  </button>
                  {text && (
                    <button
                      type="button"
                      onClick={() => {
                        setText("");
                        setSendState({ status: "idle" });
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20"
                    >
                      <TrashIcon />
                      <span>Limpiar</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {detectedLinks.length > 0 && (
                    <span className="rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1 text-xs font-semibold text-cyan-200">
                      {detectedLinks.length} link{detectedLinks.length > 1 ? "s" : ""} detectado{detectedLinks.length > 1 ? "s" : ""}
                    </span>
                  )}
                  <button
                    onClick={() => void handleGenerate()}
                    disabled={sendState.status === "loading"}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110 disabled:opacity-60"
                  >
                    <span>{sendState.status === "loading" ? "Enviando..." : "Enviar / Compartir"}</span>
                  </button>
                </div>
              </div>

              {/* Large Central Textarea */}
              <div className="p-4 sm:p-6">
                <textarea
                  ref={sendTextareaRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Pega o escribe tu texto, código o enlaces aquí..."
                  rows={10}
                  className="w-full resize-y bg-transparent text-base font-normal text-slate-100 placeholder-slate-500 outline-none leading-relaxed min-h-[220px]"
                />
              </div>

              {/* Footer Toolbar of Card */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-white/[0.02] px-4 py-3 sm:px-6">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>Expiración:</span>
                  <select
                    value={ttlSeconds}
                    onChange={(e) => setTtlSeconds(Number(e.target.value))}
                    className="rounded-lg border border-white/10 bg-[#121622] px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-cyan-400"
                  >
                    {TTL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {sendState.status === "idle" && (
                  <button
                    onClick={() => {
                      setText("");
                      setSendState({ status: "idle" });
                    }}
                    className="text-xs font-medium text-slate-400 hover:text-slate-200 transition"
                  >
                    Limpiar todo
                  </button>
                )}
              </div>
            </div>

            {/* Error Message */}
            {sendState.status === "error" && (
              <div className="rounded-xl border border-rose-400/40 bg-rose-400/10 p-4 text-sm text-rose-200">
                {sendState.message}
              </div>
            )}
          </section>
        )}

        {tab === "receive" && (
          <section className="space-y-6">
            {/* Animación indicando vinculación si no está vinculado */}
            {pairState.status !== "linked" ? (
              <div className="rounded-3xl border border-amber-400/40 bg-amber-500/10 p-6 text-center shadow-xl space-y-3 animate-pulse">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-amber-400/20 text-amber-300 text-2xl font-bold animate-bounce">
                  ↑
                </div>
                <h3 className="text-lg font-bold text-white">Dispositivo No Vinculado</h3>
                <p className="max-w-md mx-auto text-xs text-amber-100/90 leading-relaxed">
                  Para recibir contenido en tiempo real de tu otro dispositivo, **genera o ingresa el PIN de 6 dígitos en el Banner Superior** ↑.
                </p>
              </div>
            ) : (
              <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl backdrop-blur sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-white">Búsqueda Directa Activa</h2>
                  <button
                    onClick={() => void handleNearbySearch()}
                    disabled={nearbyState.status === "searching"}
                    className="rounded-xl border border-cyan-300/30 bg-cyan-400/20 px-4 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/30 transition disabled:opacity-60"
                  >
                    {nearbyState.status === "searching" ? "Buscando..." : "Actualizar / Buscar ahora"}
                  </button>
                </div>
              </div>
            )}

            {receiveState.status === "error" && (
              <div className="rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-100">
                {receiveState.message}
              </div>
            )}

            {receiveState.status === "success" && (
              <div className="rounded-2xl border border-white/10 bg-[#0b0f17] p-4 space-y-4">
                <div className="text-sm text-slate-300">
                  Código: <span className="font-semibold text-slate-100">{receiveState.code}</span>
                </div>

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
                            className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-400/20 px-4 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/30"
                          >
                            <OpenIcon />
                            <span>Abrir</span>
                          </a>
                          <button
                            onClick={() => void copyToClipboard(link)}
                            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-xs font-semibold text-slate-950"
                          >
                            <CopyIcon />
                            <span>Copiar</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {receiveState.text && (
                  <div className="rounded-xl border border-white/10 bg-[#101522] p-3 space-y-3">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-slate-100">
                      {receiveState.text}
                    </pre>
                    <button
                      className="rounded-xl bg-gradient-to-r from-cyan-300 to-blue-300 px-4 py-2 text-xs font-semibold text-slate-950"
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
          ClipCode | Transferencia rápida entre dispositivos
        </footer>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-white/15 bg-[#0d111a]/95 px-4 py-2 text-sm text-slate-100 shadow-lg shadow-black/40 backdrop-blur">
          {toast}
        </div>
      )}

      {/* 10-Second Auto-Closing QR Modal */}
      {activeQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-sm rounded-3xl border border-white/15 bg-[#0d1017] p-6 shadow-2xl text-center space-y-4">
            <button
              onClick={closeQrModal}
              className="absolute right-4 top-4 rounded-full border border-white/10 bg-white/5 p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
              title="Cerrar"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>

            <div className="space-y-2">
              <h3 className="text-lg font-bold text-white">{activeQrModal.title}</h3>

              {activeQrModal.pinCode ? (
                <div className="flex items-center justify-center gap-3 rounded-2xl border border-cyan-400/30 bg-cyan-400/10 py-2 px-4 shadow-inner">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">PIN:</span>
                  <span className="font-mono text-3xl font-black tracking-widest text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.5)]">
                    {activeQrModal.pinCode}
                  </span>
                  <button
                    onClick={() => void copyToClipboard(activeQrModal.pinCode!)}
                    className="inline-flex items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/20 p-2 text-cyan-200 hover:bg-cyan-400/35 hover:text-white transition active:scale-95 shadow-sm"
                    title="Copiar PIN"
                  >
                    <CopyIcon />
                  </button>
                </div>
              ) : activeQrModal.subtitle ? (
                <div className="flex items-center justify-center gap-2">
                  <p className="text-xs text-slate-300 font-mono">{activeQrModal.subtitle}</p>
                  <button
                    onClick={() => void copyToClipboard(activeQrModal.value)}
                    className="inline-flex items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 p-1.5 text-cyan-200 hover:bg-cyan-400/25 transition active:scale-95"
                    title="Copiar"
                  >
                    <CopyIcon />
                  </button>
                </div>
              ) : null}
            </div>

            <div className="inline-block rounded-2xl bg-white p-4 shadow-xl">
              <QRCodeCanvas value={activeQrModal.value} size={200} />
            </div>

            <div className="flex items-center justify-center pt-1 text-xs text-slate-400">
              <span className="flex items-center gap-1.5 text-cyan-300 font-medium">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
                Cierre automático en {qrCountdown}s
              </span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
