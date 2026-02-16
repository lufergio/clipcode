"use client";

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";

const AUTO_OPEN_COOLDOWN_MS = 15_000;
const AUTO_OPEN_STORAGE_PREFIX = "clipcode:auto-open-pair:";

function normalizePairCode(value: string | null): string {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

function buildPairDeepLink(pairCode: string): string {
  const template = process.env.NEXT_PUBLIC_APP_PAIR_DEEPLINK_TEMPLATE;
  if (template && template.includes("{code}")) {
    return template.replace("{code}", encodeURIComponent(pairCode));
  }

  const scheme = process.env.NEXT_PUBLIC_APP_SCHEME || "clipcode";
  return `${scheme}://pair?code=${encodeURIComponent(pairCode)}`;
}

function isAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent);
}

function isInAppContext(): boolean {
  if (typeof navigator === "undefined" || typeof document === "undefined") return false;
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
  return isAndroidWebView || isInAppBrowser || cameFromAndroidApp;
}

function buildAndroidIntentUrl(pairCode: string, fallbackUrl: string): string {
  const scheme = process.env.NEXT_PUBLIC_APP_SCHEME || "clipcode";
  const packageName = process.env.NEXT_PUBLIC_ANDROID_APP_PACKAGE;
  const fallback = encodeURIComponent(fallbackUrl);
  const packagePart = packageName ? `;package=${packageName}` : "";
  return `intent://pair?code=${encodeURIComponent(pairCode)}#Intent;scheme=${scheme}${packagePart};S.browser_fallback_url=${fallback};end`;
}

export default function OpenPairClient() {
  const params = useSearchParams();
  const pairCode = normalizePairCode(params.get("pair"));
  const autoOpenRequested = ["1", "true", "yes"].includes(
    String(params.get("auto") ?? "").toLowerCase()
  );

  const fallbackUrl = useMemo(() => {
    if (!pairCode) return "/";
    return `/?pair=${pairCode}&fromApp=1`;
  }, [pairCode]);

  const deepLinkUrl = useMemo(() => {
    if (!pairCode) return "";
    return buildPairDeepLink(pairCode);
  }, [pairCode]);

  const androidIntentUrl = useMemo(() => {
    if (!pairCode) return "";
    const absoluteFallback =
      typeof window === "undefined" ? fallbackUrl : `${window.location.origin}${fallbackUrl}`;
    return buildAndroidIntentUrl(pairCode, absoluteFallback);
  }, [fallbackUrl, pairCode]);

  const preferredOpenUrl = useMemo(() => {
    if (!pairCode) return "";
    return isAndroidDevice() ? androidIntentUrl : deepLinkUrl;
  }, [androidIntentUrl, deepLinkUrl, pairCode]);

  useEffect(() => {
    if (!pairCode) {
      window.location.replace("/");
      return;
    }

    if (isInAppContext()) {
      window.location.replace(fallbackUrl);
      return;
    }

    if (!autoOpenRequested) {
      return;
    }

    const storageKey = `${AUTO_OPEN_STORAGE_PREFIX}${pairCode}`;
    const lastAutoOpenAt = Number(localStorage.getItem(storageKey) ?? "0");
    const now = Date.now();
    if (now - lastAutoOpenAt < AUTO_OPEN_COOLDOWN_MS) {
      return;
    }
    localStorage.setItem(storageKey, String(now));
    // Evita bucles por recarga/reapertura: removemos el flag auto tras el primer intento.
    window.history.replaceState(null, "", `/open?pair=${pairCode}`);

    let hidden = false;
    const onVisibilityChange = () => {
      if (document.hidden) hidden = true;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const timer = window.setTimeout(() => {
      if (!hidden) {
        window.location.replace(fallbackUrl);
      }
    }, 1400);

    window.location.href = preferredOpenUrl;

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoOpenRequested, fallbackUrl, pairCode, preferredOpenUrl]);

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-10 text-neutral-50">
      <div className="mx-auto max-w-md rounded-2xl bg-neutral-900 p-5 ring-1 ring-neutral-800">
        <h1 className="text-lg font-semibold">Abriendo app...</h1>
        <p className="mt-2 text-sm text-neutral-300">
          Si no se abre automaticamente, toca el boton para continuar en web.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={preferredOpenUrl || "#"}
            className="rounded-xl bg-neutral-50 px-4 py-2 text-sm font-semibold text-neutral-950"
          >
            Abrir app
          </a>
          <a
            href={fallbackUrl}
            className="rounded-xl bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100"
          >
            Continuar en web
          </a>
        </div>
      </div>
    </main>
  );
}
