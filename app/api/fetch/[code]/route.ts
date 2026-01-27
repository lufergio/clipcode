import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

type StoredPayload =
  | { text: string; createdAt?: number; reads?: number }
  | string
  | null;

/**
 * GET /api/fetch/:code
 * - Recupera el texto asociado al código.
 * - Por defecto, se destruye al leer (1 sola lectura).
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ code: string }> }
) {
  try {
    const { code: rawCode } = await context.params;

    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!code || code.length > 12) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    const key = `clipcode:${code}`;
    const raw = await redis.get<StoredPayload>(key);

    if (!raw) {
      return NextResponse.json(
        { error: "Code not found or expired" },
        { status: 404 }
      );
    }

    // ✅ Normalizar payload (puede venir como string JSON o como objeto)
    let payload: { text?: string } = {};
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { text: raw }; // fallback: tratar string como texto directo
      }
    } else {
      payload = raw as any;
    }

    if (!payload?.text) {
      return NextResponse.json(
        { error: "Code not found or expired" },
        { status: 404 }
      );
    }

    // ✅ Auto-destruir (1 lectura)
    await redis.del(key);

    return NextResponse.json({
      code,
      text: payload.text,
      consumed: true,
    });
  } catch (error: any) {
    console.error("❌ /api/fetch error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
