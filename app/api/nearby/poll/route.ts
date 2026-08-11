import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const DEBUG_TRACE = process.env.NODE_ENV !== "production";
const MAX_TEXT_FILE_SIZE_BYTES = 256 * 1024;
const ALLOWED_TEXT_FILE_EXTENSIONS = new Set([
  "txt", "json", "sql", "md", "markdown", "csv", "tsv", "xml", "yaml", "yml",
  "toml", "ini", "conf", "config", "log", "html", "htm", "css", "scss", "sass",
  "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "dart", "java", "kt",
  "kts", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "rb", "php", "swift",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "graphql", "gql", "prisma",
  "vue", "svelte", "properties", "gradle",
]);

function isAllowedTextFileName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (["dockerfile", "makefile", "procfile", ".gitignore", ".editorconfig", ".npmrc"].includes(normalized)) {
    return true;
  }
  if (normalized === ".env" || normalized.startsWith(".env.")) return true;
  const extension = normalized.includes(".") ? normalized.split(".").pop() ?? "" : "";
  return ALLOWED_TEXT_FILE_EXTENSIONS.has(extension);
}

type NearbyPayload = {
  messageId?: string;
  code?: string;
  links?: string[];
  text?: string;
  file?: SharedTextFile;
  senderDeviceLabel?: string;
  createdAt?: number;
};

type SharedTextFile = {
  name: string;
  content: string;
  size: number;
  mimeType: "text/plain";
};

function normalizeTextFile(value: unknown): SharedTextFile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { name?: unknown; content?: unknown; size?: unknown };
  const name = String(raw.name ?? "").trim();
  if (typeof raw.content !== "string") return null;
  const content = raw.content;
  const size = new TextEncoder().encode(content).byteLength;
  if (!isAllowedTextFileName(name) || size > MAX_TEXT_FILE_SIZE_BYTES) {
    return null;
  }
  return { name, content, size, mimeType: "text/plain" };
}

type NearbyQueuePayload = {
  version?: number;
  items?: NearbyPayload[];
};

function normalizeDeviceId(value: string | null): string {
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
  console.info("[clipcode][api][nearby/poll]", event, details);
}

function normalizeNearbyPayload(input: NearbyPayload | null | undefined): NearbyPayload | null {
  const links = Array.isArray(input?.links)
    ? input!.links.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const text = String(input?.text ?? "").trim();
  const file = normalizeTextFile(input?.file);
  const code = String(input?.code ?? "").trim().toUpperCase();
  const messageId = normalizeMessageId(input?.messageId);
  const senderDeviceLabel = String(input?.senderDeviceLabel ?? "").trim().slice(0, 40);

  if (!links.length && !text && !file) return null;

  return {
    messageId: messageId || undefined,
    code: code || undefined,
    links,
    text: text || undefined,
    file: file || undefined,
    senderDeviceLabel: senderDeviceLabel || undefined,
    createdAt:
      Number.isFinite(Number(input?.createdAt)) && Number(input?.createdAt) > 0
        ? Number(input?.createdAt)
        : Date.now(),
  };
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
    return maybeQueue.items
      .map((item) => normalizeNearbyPayload(item))
      .filter(Boolean) as NearbyPayload[];
  }

  const single = normalizeNearbyPayload(parsed as NearbyPayload);
  return single ? [single] : [];
}

/**
 * GET /api/nearby/poll?receiverDeviceId=...
 * Si hay item en la bandeja emparejada, lo devuelve.
 * El consumo se confirma via /api/nearby/ack con messageId.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const receiverDeviceId = normalizeDeviceId(
      url.searchParams.get("receiverDeviceId")
    );
    debugTrace("request", {
      receiverDeviceId: receiverDeviceId || null,
    });

    if (!receiverDeviceId) {
      return NextResponse.json(
        { found: false, error: "Invalid receiverDeviceId" },
        { status: 400 }
      );
    }

    const key = `clipcode:nearby:${receiverDeviceId}`;
    const raw = await redis.get<string | NearbyPayload | NearbyQueuePayload>(key);
    debugTrace("lookup", {
      receiverDeviceId,
      key,
      found: Boolean(raw),
    });

    if (!raw) {
      return NextResponse.json({ found: false }, { status: 200 });
    }

    const items = parseNearbyItems(raw);
    if (!items.length) {
      await redis.del(key);
      debugTrace("discarded-empty", {
        receiverDeviceId,
      });
      return NextResponse.json({ found: false }, { status: 200 });
    }

    const currentItem = items[0];
    const links = Array.isArray(currentItem.links) ? currentItem.links : [];
    const text = String(currentItem.text ?? "").trim();
    const file = normalizeTextFile(currentItem.file);
    const code = String(currentItem.code ?? "").trim().toUpperCase();
    const messageId = normalizeMessageId(currentItem.messageId);
    const senderDeviceLabel = String(currentItem.senderDeviceLabel ?? "").trim().slice(0, 40);

    // Compatibilidad con payloads sin messageId: consume inmediato.
    if (!messageId) {
      const remaining = items.slice(1);
      if (remaining.length) {
        const ttl = await redis.ttl(key);
        const ex = ttl > 0 ? ttl : 60;
        await redis.set(
          key,
          JSON.stringify({ version: 2, items: remaining } satisfies NearbyQueuePayload),
          { ex }
        );
      } else {
        await redis.del(key);
      }
      debugTrace("consumed-legacy", {
        receiverDeviceId,
        code: code || null,
        linksCount: links.length,
        hasText: Boolean(text),
      });
    }

    debugTrace("ready", {
      receiverDeviceId,
      messageId: messageId || null,
      code: code || null,
      linksCount: links.length,
      hasText: Boolean(text),
      queueLength: items.length,
    });

    return NextResponse.json({
      found: true,
      item: {
        messageId: messageId || undefined,
        code: code || undefined,
        links,
        text: text || undefined,
        file: file || undefined,
        senderDeviceLabel: senderDeviceLabel || undefined,
      },
    });
  } catch (error: unknown) {
    console.error("GET /api/nearby/poll error:", error);
    return NextResponse.json({ found: false, error: "Internal error" }, { status: 500 });
  }
}
