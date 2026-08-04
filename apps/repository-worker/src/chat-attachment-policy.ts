import type { RepositoryChatAttachment } from "@phaseatlas/contracts";
import { isSafeAgentPath } from "@phaseatlas/core";

const SENSITIVE_ATTACHMENT = /(^|\/)(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|p12|pfx|key))$/i;
const CHAT_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;

export function safeChatAttachments(input: RepositoryChatAttachment[] = []): RepositoryChatAttachment[] {
  if (input.length > 12) throw new Error("A chat request accepts at most 12 attachments.");
  const unique = new Set<string>();
  const attachments: RepositoryChatAttachment[] = [];
  let imageCount = 0;
  let imageBytes = 0;
  for (const attachment of input) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new Error("Chat attachment is invalid.");
    }
    if (attachment.type === "image") {
      if (Object.keys(attachment).some((field) => !["type", "name", "mediaType", "data"].includes(field)) ||
          typeof attachment.name !== "string" || typeof attachment.mediaType !== "string" || typeof attachment.data !== "string") {
        throw new Error("Chat image attachment is invalid.");
      }
      const name = attachment.name.trim().replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "") ?? "";
      if (!name || name.length > 160 || !CHAT_IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
        throw new Error("Chat image name or media type is invalid.");
      }
      if (!attachment.data || attachment.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) {
        throw new Error(`Chat image ${name} is not valid base64 data.`);
      }
      const bytes = Buffer.byteLength(attachment.data, "base64");
      if (bytes > MAX_CHAT_IMAGE_BYTES) throw new Error(`Chat image ${name} exceeds the 5 MB limit.`);
      imageCount += 1;
      imageBytes += bytes;
      if (imageCount > 4) throw new Error("A chat request accepts at most 4 images.");
      if (imageBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("Chat images exceed the 16 MB combined limit.");
      const fingerprint = `${attachment.mediaType}:${attachment.data.length}:${attachment.data.slice(0, 64)}:${attachment.data.slice(-64)}`;
      if (!unique.has(fingerprint)) {
        unique.add(fingerprint);
        attachments.push({ type: "image", name, mediaType: attachment.mediaType, data: attachment.data });
      }
      continue;
    }
    if (typeof attachment.path !== "string" || Object.keys(attachment).some((field) => !["type", "path"].includes(field)) ||
        (attachment.type !== undefined && attachment.type !== "repository")) {
      throw new Error("Chat repository attachment is invalid.");
    }
    const normalized = attachment.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!isSafeAgentPath(normalized) || SENSITIVE_ATTACHMENT.test(normalized)) {
      throw new Error(`Chat attachment ${attachment.path} is not allowed.`);
    }
    if (!unique.has(`path:${normalized}`)) {
      unique.add(`path:${normalized}`);
      attachments.push({ path: normalized });
    }
  }
  return attachments;
}
