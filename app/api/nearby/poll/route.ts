import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

type NearbyPayload = {
  code?: string;
  links?: string[];
  text?: string;
  createdAt?: number;
};

function normalizeDeviceId(value: string | null): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

/**
 * GET /api/nearby/poll?receiverDeviceId=...
 * Si hay item en la bandeja emparejada, lo devuelve y lo consume.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const receiverDeviceId = normalizeDeviceId(
      url.searchParams.get("receiverDeviceId")
    );

    if (!receiverDeviceId) {
      return NextResponse.json(
        { found: false, error: "Invalid receiverDeviceId" },
        { status: 400 }
      );
    }

    const key = `clipcode:nearby:${receiverDeviceId}`;
    const raw = await redis.get<string | NearbyPayload>(key);

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

    if (!links.length && !text) {
      await redis.del(key);
      return NextResponse.json({ found: false }, { status: 200 });
    }

    // Mantiene semantica de consumo unico.
    await redis.del(key);

    return NextResponse.json({
      found: true,
      item: {
        code: code || undefined,
        links,
        text: text || undefined,
      },
    });
  } catch (error: unknown) {
    console.error("GET /api/nearby/poll error:", error);
    return NextResponse.json({ found: false, error: "Internal error" }, { status: 500 });
  }
}
