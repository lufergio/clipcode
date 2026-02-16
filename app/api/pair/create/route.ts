import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateCode } from "@/lib/code-generator";

const PAIR_CODE_TTL_SECONDS = 600; // 10 min

type PairCreateBody = {
  receiverDeviceId?: unknown;
  receiverDeviceLabel?: unknown;
};

type PairCodePayload = {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
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

/**
 * POST /api/pair/create
 * Body: { receiverDeviceId: string; receiverDeviceLabel?: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PairCreateBody;
    const receiverDeviceId = normalizeDeviceId(body?.receiverDeviceId);
    const receiverDeviceLabel = normalizeDeviceLabel(body?.receiverDeviceLabel);

    if (!receiverDeviceId) {
      return NextResponse.json(
        { error: "Invalid receiverDeviceId" },
        { status: 400 }
      );
    }

    let pairCode = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(6);
      const exists = await redis.exists(`clipcode:pair:code:${candidate}`);
      if (!exists) {
        pairCode = candidate;
        break;
      }
    }

    if (!pairCode) {
      return NextResponse.json(
        { error: "Could not generate pair code" },
        { status: 500 }
      );
    }

    const payload: PairCodePayload = {
      receiverDeviceId,
      receiverDeviceLabel: receiverDeviceLabel || undefined,
    };
    await redis.set(
      `clipcode:pair:code:${pairCode}`,
      JSON.stringify(payload),
      { ex: PAIR_CODE_TTL_SECONDS }
    );

    return NextResponse.json({
      pairCode,
      expiresIn: PAIR_CODE_TTL_SECONDS,
      receiverDeviceLabel: receiverDeviceLabel || undefined,
    });
  } catch (error: unknown) {
    console.error("POST /api/pair/create error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
