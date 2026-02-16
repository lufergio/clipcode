"use client";

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";

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

export default function OpenPairPage() {
  const params = useSearchParams();
  const pairCode = normalizePairCode(params.get("pair"));

  const fallbackUrl = useMemo(() => {
    if (!pairCode) return "/";
    return `/?pair=${pairCode}`;
  }, [pairCode]);

  const deepLinkUrl = useMemo(() => {
    if (!pairCode) return "";
    return buildPairDeepLink(pairCode);
  }, [pairCode]);

  useEffect(() => {
    if (!pairCode) {
      window.location.replace("/");
      return;
    }

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

    window.location.href = deepLinkUrl;

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deepLinkUrl, fallbackUrl, pairCode]);

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-10 text-neutral-50">
      <div className="mx-auto max-w-md rounded-2xl bg-neutral-900 p-5 ring-1 ring-neutral-800">
        <h1 className="text-lg font-semibold">Abriendo app...</h1>
        <p className="mt-2 text-sm text-neutral-300">
          Si no se abre automaticamente, toca el boton para continuar en web.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={deepLinkUrl || "#"}
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
