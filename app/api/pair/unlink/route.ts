import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

type PairUnlinkBody = {
  senderDeviceId?: unknown;
  receiverDeviceId?: unknown;
};

type SenderPairPayload = {
  receiverDeviceId?: unknown;
};

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

function resolveReceiverDeviceId(raw: string | SenderPairPayload | null): string {
  if (!raw) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as SenderPairPayload;
      return normalizeDeviceId(parsed?.receiverDeviceId);
    } catch {
      return normalizeDeviceId(raw);
    }
  }
  return normalizeDeviceId(raw.receiverDeviceId);
}

/**
 * POST /api/pair/unlink
 * Body: { senderDeviceId: string; receiverDeviceId?: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PairUnlinkBody;
    const senderDeviceId = normalizeDeviceId(body.senderDeviceId);
    let receiverDeviceId = normalizeDeviceId(body.receiverDeviceId);

    if (!senderDeviceId) {
      return NextResponse.json(
        { ok: false, error: "senderDeviceId is required" },
        { status: 400 }
      );
    }

    const senderKey = `clipcode:pair:sender:${senderDeviceId}`;
    if (!receiverDeviceId) {
      const raw = await redis.get<string | SenderPairPayload>(senderKey);
      receiverDeviceId = resolveReceiverDeviceId(raw);
    }

    await redis.del(senderKey);

    if (receiverDeviceId) {
      const receiverKey = `clipcode:pair:sender:${receiverDeviceId}`;
      const rawReverse = await redis.get<string | SenderPairPayload>(receiverKey);
      const reverseTarget = resolveReceiverDeviceId(rawReverse);
      if (!reverseTarget || reverseTarget === senderDeviceId) {
        await redis.del(receiverKey);
      }
    }

    return NextResponse.json({
      ok: true,
      senderDeviceId,
      receiverDeviceId: receiverDeviceId || undefined,
    });
  } catch (error: unknown) {
    console.error("POST /api/pair/unlink error:", error);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
