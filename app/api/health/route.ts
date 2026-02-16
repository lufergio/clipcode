import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

/**
 * Endpoint para validar conexión Redis.
 * GET /api/health
 */
export async function GET() {
  try {
    await redis.set("clipcode:health", "ok", { ex: 10 });
    const value = await redis.get<string>("clipcode:health");

    return NextResponse.json({
      ok: true,
      redis: value,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
