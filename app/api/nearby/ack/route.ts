import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const DEBUG_TRACE = process.env.NODE_ENV !== "production";

type NearbyPayload = {
  messageId?: string;
};

type NearbyAckBody = {
  receiverDeviceId?: unknown;
  messageId?: unknown;
};

function normalizeDeviceId(value: unknown): string {
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
  console.info("[clipcode][api][nearby/ack]", event, details);
}

/**
 * POST /api/nearby/ack
 * Body: { receiverDeviceId: string; messageId: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as NearbyAckBody;
    const receiverDeviceId = normalizeDeviceId(body?.receiverDeviceId);
    const messageId = normalizeMessageId(body?.messageId);

    if (!receiverDeviceId || !messageId) {
      return NextResponse.json(
        { ok: false, error: "receiverDeviceId and messageId are required" },
        { status: 400 }
      );
    }

    const key = `clipcode:nearby:${receiverDeviceId}`;
    const raw = await redis.get<string | NearbyPayload>(key);

    if (!raw) {
      debugTrace("ack:not-found", { receiverDeviceId, messageId });
      return NextResponse.json({ ok: true, consumed: false }, { status: 200 });
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

    const storedMessageId = normalizeMessageId(payload.messageId);
    if (!storedMessageId || storedMessageId !== messageId) {
      debugTrace("ack:mismatch", {
        receiverDeviceId,
        messageId,
        storedMessageId: storedMessageId || null,
      });
      return NextResponse.json({ ok: true, consumed: false }, { status: 200 });
    }

    await redis.del(key);
    debugTrace("ack:consumed", {
      receiverDeviceId,
      messageId,
    });

    return NextResponse.json({ ok: true, consumed: true }, { status: 200 });
  } catch (error: unknown) {
    console.error("POST /api/nearby/ack error:", error);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
