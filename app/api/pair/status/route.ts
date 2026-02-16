import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

type SenderPairPayload = {
  receiverDeviceId?: unknown;
  receiverDeviceLabel?: unknown;
  senderDeviceLabel?: unknown;
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

function resolvePairPayload(raw: string | SenderPairPayload | null): {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
} | null {
  if (!raw) return null;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as SenderPairPayload;
      const receiverDeviceId = normalizeDeviceId(parsed?.receiverDeviceId);
      if (!receiverDeviceId) return null;
      return {
        receiverDeviceId,
        receiverDeviceLabel: normalizeDeviceLabel(parsed?.receiverDeviceLabel) || undefined,
      };
    } catch {
      const receiverDeviceId = normalizeDeviceId(raw);
      if (!receiverDeviceId) return null;
      return { receiverDeviceId };
    }
  }

  const receiverDeviceId = normalizeDeviceId(raw.receiverDeviceId);
  if (!receiverDeviceId) return null;
  return {
    receiverDeviceId,
    receiverDeviceLabel: normalizeDeviceLabel(raw.receiverDeviceLabel) || undefined,
  };
}

/**
 * GET /api/pair/status?deviceId=...
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const deviceId = normalizeDeviceId(url.searchParams.get("deviceId"));
    if (!deviceId) {
      return NextResponse.json({ linked: false, error: "Invalid deviceId" }, { status: 400 });
    }

    const raw = await redis.get<string | SenderPairPayload>(
      `clipcode:pair:sender:${deviceId}`
    );
    const pair = resolvePairPayload(raw);
    if (!pair) {
      return NextResponse.json({ linked: false }, { status: 200 });
    }

    return NextResponse.json(
      {
        linked: true,
        receiverDeviceId: pair.receiverDeviceId,
        receiverDeviceLabel: pair.receiverDeviceLabel,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error("GET /api/pair/status error:", error);
    return NextResponse.json({ linked: false, error: "Internal error" }, { status: 500 });
  }
}
