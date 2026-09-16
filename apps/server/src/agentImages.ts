import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentImageInput {
  path: string;
  mimeType?: string;
}

export interface LoadedAgentImage {
  path: string;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  data: string;
}

export interface StoredAgentImage {
  id: string;
  kind: "image";
  path: string;
  mimeType: LoadedAgentImage["mimeType"];
}

const IMAGE_MIME_BY_EXTENSION: Record<string, LoadedAgentImage["mimeType"]> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20_000_000;

const IMAGE_EXTENSION_BY_MIME: Record<LoadedAgentImage["mimeType"], string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function outputImageBlock(raw: unknown): { data: string; mimeType: LoadedAgentImage["mimeType"] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as { type?: unknown; content?: unknown };
  const candidate = item.type === "content" ? item.content : item;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const block = candidate as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return null;
  const mimeType = block.mimeType.toLowerCase().split(";")[0] as LoadedAgentImage["mimeType"];
  if (!(mimeType in IMAGE_EXTENSION_BY_MIME)) return null;
  return { data: block.data, mimeType };
}

/**
 * Persist displayable images returned by ACP agent/tool content blocks.
 *
 * ACP carries images as base64, while chat history intentionally stores paths
 * so SQLite does not absorb multi-megabyte payloads. Content hashes make
 * repeated tool-call updates idempotent and keep the message attachment ID
 * stable across the stream.
 */
export async function saveAgentOutputImages(
  raw: unknown,
  directory = process.env.TERMANY_AGENT_IMAGE_DIR ?? path.join(os.homedir(), ".termany", "agent-images")
): Promise<StoredAgentImage[]> {
  const items = Array.isArray(raw) ? raw : [raw];
  const images: StoredAgentImage[] = [];
  for (const item of items.slice(0, MAX_IMAGES)) {
    const block = outputImageBlock(item);
    if (!block || block.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) continue;
    const data = Buffer.from(block.data, "base64");
    if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) continue;
    const hash = createHash("sha256").update(block.mimeType).update("\0").update(data).digest("hex");
    const filePath = path.join(directory, `${hash}.${IMAGE_EXTENSION_BY_MIME[block.mimeType]}`);
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(filePath, data, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    images.push({ id: `acp-image-${hash.slice(0, 24)}`, kind: "image", path: filePath, mimeType: block.mimeType });
  }
  return images;
}

/** Read only image formats accepted by both Anthropic and OpenAI-compatible
 * vision APIs. Paths stay in persisted chat state; bytes exist only for the
 * duration of one request. */
export async function loadAgentImages(raw: unknown): Promise<LoadedAgentImage[]> {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_IMAGES) throw new Error(`A message can contain at most ${MAX_IMAGES} images`);
  return Promise.all(raw.map(async (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid image attachment");
    const filePath = String((item as AgentImageInput).path ?? "").trim();
    if (!filePath) throw new Error("Image path is required");
    const absolutePath = path.resolve(filePath);
    const mimeType = IMAGE_MIME_BY_EXTENSION[path.extname(absolutePath).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported image format; use PNG, JPEG, WebP, or GIF");
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || !stat.size) throw new Error("Image attachment is empty");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("Image attachment is larger than 20 MB");
    return { path: absolutePath, mimeType, data: (await fs.readFile(absolutePath)).toString("base64") };
  }));
}
