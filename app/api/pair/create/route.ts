import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateCode } from "@/lib/code-generator";

const PAIR_CODE_TTL_SECONDS = 600; // 10 min

type PairCreateBody = {
  receiverDeviceId?: unknown;
};

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

/**
 * POST /api/pair/create
 * Body: { receiverDeviceId: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PairCreateBody;
    const receiverDeviceId = normalizeDeviceId(body?.receiverDeviceId);

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

    await redis.set(`clipcode:pair:code:${pairCode}`, receiverDeviceId, {
      ex: PAIR_CODE_TTL_SECONDS,
    });

    return NextResponse.json({
      pairCode,
      expiresIn: PAIR_CODE_TTL_SECONDS,
    });
  } catch (error: unknown) {
    console.error("POST /api/pair/create error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
