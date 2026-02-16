import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const PAIRING_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

type PairConfirmBody = {
  pairCode?: unknown;
  senderDeviceId?: unknown;
  senderDeviceLabel?: unknown;
};

type PairCodePayload = {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
};

type SenderPairPayload = {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
  senderDeviceLabel?: string;
};

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

function normalizeDeviceLabel(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

function normalizePairCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/**
 * POST /api/pair/confirm
 * Body: { pairCode: string; senderDeviceId: string; senderDeviceLabel?: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PairConfirmBody;
    const pairCode = normalizePairCode(body?.pairCode);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId);
    const senderDeviceLabel = normalizeDeviceLabel(body?.senderDeviceLabel);

    if (!pairCode || !senderDeviceId) {
      return NextResponse.json(
        { error: "pairCode and senderDeviceId are required" },
        { status: 400 }
      );
    }

    const pairCodeKey = `clipcode:pair:code:${pairCode}`;
    const rawPairCodePayload = await redis.get<string | PairCodePayload>(pairCodeKey);

    let receiverDeviceId = "";
    let receiverDeviceLabel = "";

    if (typeof rawPairCodePayload === "string") {
      try {
        const parsed = JSON.parse(rawPairCodePayload) as PairCodePayload;
        receiverDeviceId = normalizeDeviceId(parsed?.receiverDeviceId);
        receiverDeviceLabel = normalizeDeviceLabel(parsed?.receiverDeviceLabel);
      } catch {
        // Compatibilidad con formato legado (string = receiverDeviceId)
        receiverDeviceId = normalizeDeviceId(rawPairCodePayload);
      }
    } else {
      receiverDeviceId = normalizeDeviceId(rawPairCodePayload?.receiverDeviceId);
      receiverDeviceLabel = normalizeDeviceLabel(rawPairCodePayload?.receiverDeviceLabel);
    }

    if (!receiverDeviceId) {
      return NextResponse.json(
        { error: "Pair code not found or expired" },
        { status: 404 }
      );
    }

    const senderPairPayload: SenderPairPayload = {
      receiverDeviceId,
      receiverDeviceLabel: receiverDeviceLabel || undefined,
      senderDeviceLabel: senderDeviceLabel || undefined,
    };
    await redis.set(
      `clipcode:pair:sender:${senderDeviceId}`,
      JSON.stringify(senderPairPayload),
      { ex: PAIRING_TTL_SECONDS }
    );
    await redis.del(pairCodeKey);

    return NextResponse.json({
      linked: true,
      receiverDeviceId,
      receiverDeviceLabel: receiverDeviceLabel || undefined,
      expiresIn: PAIRING_TTL_SECONDS,
    });
  } catch (error: unknown) {
    console.error("POST /api/pair/confirm error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
