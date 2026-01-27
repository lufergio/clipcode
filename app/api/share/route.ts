import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateCode } from "@/lib/code-generator";

const TTL_SECONDS = 300; // 2 minutos
const MAX_SIZE = 5_000; // 5 KB aprox

/**
 * POST /api/share
 * Body: { text: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const text = String(body?.text ?? "").trim();

    if (!text) {
      return NextResponse.json(
        { error: "Text is required" },
        { status: 400 }
      );
    }

    if (text.length > MAX_SIZE) {
      return NextResponse.json(
        { error: "Text too large" },
        { status: 413 }
      );
    }

    // Intentamos generar un código único (máx 5 intentos)
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(4);
      const exists = await redis.exists(`clipcode:${candidate}`);
      if (!exists) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return NextResponse.json(
        { error: "Could not generate unique code" },
        { status: 500 }
      );
    }

    const payload = {
      text,
      createdAt: Date.now(),
      reads: 0,
    };

    // Guardar con TTL
    await redis.set(`clipcode:${code}`, JSON.stringify(payload), {
      ex: TTL_SECONDS,
    });


    return NextResponse.json({
      code,
      expiresIn: TTL_SECONDS,
    });
  } catch (error: any) {
    console.error("❌ /api/share error:", error);

    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }
}
