import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const DEBUG_TRACE = process.env.NODE_ENV !== "production";

type NearbyPayload = {
  messageId?: string;
};

type NearbyQueuePayload = {
  version?: number;
  items?: NearbyPayload[];
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

function parseNearbyItems(raw: string | NearbyPayload | NearbyQueuePayload | null): NearbyPayload[] {
  if (!raw) return [];

  const parsed = (() => {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    return raw;
  })();

  if (!parsed || typeof parsed !== "object") return [];

  const maybeQueue = parsed as NearbyQueuePayload;
  if (Array.isArray(maybeQueue.items)) {
    return maybeQueue.items;
  }
  return [parsed as NearbyPayload];
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
    const raw = await redis.get<string | NearbyPayload | NearbyQueuePayload>(key);

    if (!raw) {
      debugTrace("ack:not-found", { receiverDeviceId, messageId });
      return NextResponse.json({ ok: true, consumed: false }, { status: 200 });
    }

    const items = parseNearbyItems(raw);
    const remaining = items.filter(
      (item) => normalizeMessageId(item.messageId) !== messageId
    );
    const consumed = remaining.length < items.length;

    if (!consumed) {
      debugTrace("ack:mismatch", {
        receiverDeviceId,
        messageId,
        queueLength: items.length,
      });
      return NextResponse.json({ ok: true, consumed: false }, { status: 200 });
    }

    if (!remaining.length) {
      await redis.del(key);
    } else {
      const ttl = await redis.ttl(key);
      const ex = ttl > 0 ? ttl : 60;
      await redis.set(
        key,
        JSON.stringify({
          version: 2,
          items: remaining,
        } satisfies NearbyQueuePayload),
        { ex }
      );
    }
    debugTrace("ack:consumed", {
      receiverDeviceId,
      messageId,
      queueLength: remaining.length,
    });

    return NextResponse.json({ ok: true, consumed: true }, { status: 200 });
  } catch (error: unknown) {
    console.error("POST /api/nearby/ack error:", error);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
