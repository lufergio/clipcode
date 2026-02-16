import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const DEBUG_TRACE = process.env.NODE_ENV !== "production";

type NearbyPayload = {
  messageId?: string;
  code?: string;
  links?: string[];
  text?: string;
  senderDeviceLabel?: string;
  createdAt?: number;
};

function normalizeDeviceId(value: string | null): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

function normalizeMessageId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(normalized)) return "";
  return normalized;
}

function debugTrace(event: string, details: Record<string, unknown>) {
  if (!DEBUG_TRACE) return;
  console.info("[clipcode][api][nearby/poll]", event, details);
}

/**
 * GET /api/nearby/poll?receiverDeviceId=...
 * Si hay item en la bandeja emparejada, lo devuelve.
 * El consumo se confirma via /api/nearby/ack con messageId.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const receiverDeviceId = normalizeDeviceId(
      url.searchParams.get("receiverDeviceId")
    );
    debugTrace("request", {
      receiverDeviceId: receiverDeviceId || null,
    });

    if (!receiverDeviceId) {
      return NextResponse.json(
        { found: false, error: "Invalid receiverDeviceId" },
        { status: 400 }
      );
    }

    const key = `clipcode:nearby:${receiverDeviceId}`;
    const raw = await redis.get<string | NearbyPayload>(key);
    debugTrace("lookup", {
      receiverDeviceId,
      key,
      found: Boolean(raw),
    });

    if (!raw) {
      return NextResponse.json({ found: false }, { status: 200 });
    }

    let payload: NearbyPayload = {};
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw) as NearbyPayload;
      } catch {
        payload = {};
      }
    } else {
      payload = raw;
    }

    const links = Array.isArray(payload.links)
      ? payload.links
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
      : [];
    const text = String(payload.text ?? "").trim();
    const code = String(payload.code ?? "").trim().toUpperCase();
    const messageId = normalizeMessageId(payload.messageId);
    const senderDeviceLabel = String(payload.senderDeviceLabel ?? "")
      .trim()
      .slice(0, 40);

    if (!links.length && !text) {
      await redis.del(key);
      debugTrace("discarded-empty", {
        receiverDeviceId,
      });
      return NextResponse.json({ found: false }, { status: 200 });
    }

    // Compatibilidad con payloads sin messageId: consume inmediato.
    if (!messageId) {
      await redis.del(key);
      debugTrace("consumed-legacy", {
        receiverDeviceId,
        code: code || null,
        linksCount: links.length,
        hasText: Boolean(text),
      });
    }

    debugTrace("ready", {
      receiverDeviceId,
      messageId: messageId || null,
      code: code || null,
      linksCount: links.length,
      hasText: Boolean(text),
    });

    return NextResponse.json({
      found: true,
      item: {
        messageId: messageId || undefined,
        code: code || undefined,
        links,
        text: text || undefined,
        senderDeviceLabel: senderDeviceLabel || undefined,
      },
    });
  } catch (error: unknown) {
    console.error("GET /api/nearby/poll error:", error);
    return NextResponse.json({ found: false, error: "Internal error" }, { status: 500 });
  }
}
