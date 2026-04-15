import { WebClient, type FilesInfoResponse } from "@slack/web-api";
import { createRequire } from "node:module";
import AdmZip from "adm-zip";

// pdf-parse v2+ is CJS-only; load via createRequire to work from ESM.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: (buf: Buffer) => Promise<any> = require("pdf-parse");

export type SlackDeps = {
  client: WebClient;
  token?: string;
  fetchFn?: typeof fetch;
};

export type SlackAttachment = Record<string, unknown>;
export type SlackFile = Record<string, unknown>;
type SlackFileObject = NonNullable<FilesInfoResponse["file"]>;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/x-sql",
  "application/x-httpd-php",
  "application/graphql",
  "application/x-python-code",
  "application/toml",
  "application/x-toml",
]);

const TEXT_FILE_TYPES = new Set([
  // Plain text / docs
  "txt",
  "text",
  "md",
  "markdown",
  "rst",
  "asciidoc",
  "adoc",
  // Data / config
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "properties",
  "cfg",
  "conf",
  "plist",
  // Web / markup
  "html",
  "htm",
  "xhtml",
  "xml",
  "svg",
  "css",
  "scss",
  "less",
  // Scripts / code
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "groovy",
  "kt",
  "kts",
  "scala",
  "c",
  "cpp",
  "cc",
  "h",
  "hpp",
  "cs",
  "php",
  "pl",
  "lua",
  "r",
  "m",
  "swift",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  // DB / query / API
  "sql",
  "graphql",
  "gql",
  "proto",
  // Ops / infra
  "dockerfile",
  "makefile",
  "tf",
  "tfvars",
  "hcl",
  // Diffs
  "diff",
  "patch",
  // Captions / logs
  "srt",
  "vtt",
  "log",
  "out",
  "err",
]);

export interface SlackFileMetadata {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
}

export type SlackFileReadResult =
  | {
      kind: "text";
      file: SlackFileMetadata;
      text: string;
      truncated: boolean;
      source: "inline" | "download" | "pdf-extract" | "zip-manifest" | "utf8-sniff";
    }
  | {
      kind: "image";
      file: SlackFileMetadata;
      mimeType: string;
      data: string;
    };

export type SlackBlock = Record<string, unknown>;

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<{ ts: string; channel: string }> {
  const result = await deps.client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(blocks ? { blocks } : {}),
  });
  return { ts: result.ts ?? "", channel: result.channel ?? channel };
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackDeps,
  blocks?: SlackBlock[],
): Promise<void> {
  await deps.client.chat.update({ channel, ts, text, ...(blocks ? { blocks } : {}) });
}

export async function deleteMessage(channel: string, ts: string, deps: SlackDeps): Promise<void> {
  await deps.client.chat.delete({ channel, ts });
}

export async function addReaction(
  channel: string,
  timestamp: string,
  name: string,
  deps: SlackDeps,
): Promise<void> {
  await deps.client.reactions.add({ channel, timestamp, name });
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  type?: string;
  attachments?: SlackAttachment[];
  files?: SlackFile[];
}

export async function readThread(
  channel: string,
  threadTs: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

export async function getChannelHistory(
  channel: string,
  limit: number,
  deps: SlackDeps,
): Promise<SlackMessage[]> {
  const result = await deps.client.conversations.history({
    channel,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

export async function readSlackFile(
  fileId: string,
  maxBytes: number,
  deps: SlackDeps,
): Promise<SlackFileReadResult> {
  const result = await deps.client.files.info({ file: fileId });
  const file = result.file;

  if (!file) {
    throw new Error(`Slack file not found: ${fileId}`);
  }

  const metadata = toSlackFileMetadata(file);
  const inlineText = getInlineFileText(result, file);
  if (inlineText) {
    return {
      kind: "text",
      file: metadata,
      text: inlineText,
      truncated: Boolean(result.is_truncated || file.preview_is_truncated),
      source: "inline",
    };
  }

  const downloadUrl = file.url_private_download ?? file.url_private;
  if (!downloadUrl) {
    throw new Error(`Slack file is not downloadable: ${fileId}`);
  }

  const downloaded = await downloadSlackFile(downloadUrl, maxBytes, deps);

  if (isImageFile(file, downloaded.mimeType)) {
    return {
      kind: "image",
      file: metadata,
      mimeType: downloaded.mimeType,
      data: downloaded.bytes.toString("base64"),
    };
  }

  if (isTextLikeFile(file, downloaded.mimeType)) {
    return {
      kind: "text",
      file: metadata,
      text: downloaded.bytes.toString("utf8"),
      truncated: false,
      source: "download",
    };
  }

  // --- PDF: extract text server-side via pdf-parse ---
  if (isPdfFile(file, downloaded.mimeType, downloaded.bytes)) {
    try {
      const parsed = await pdfParse(downloaded.bytes);
      const pages = parsed?.numpages ?? 0;
      const info = parsed?.info ? JSON.stringify(parsed.info) : "";
      const header = `[PDF] ${metadata.name ?? metadata.title ?? fileId} — ${pages} page(s)${info ? ` — info: ${info}` : ""}\n\n`;
      return {
        kind: "text",
        file: metadata,
        text: header + (parsed?.text ?? "(no extractable text — possibly a scanned PDF)"),
        truncated: false,
        source: "pdf-extract",
      };
    } catch (err) {
      throw new Error(
        `PDF extract failed for ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- ZIP: list entries + inline small text files ---
  if (isZipFile(file, downloaded.mimeType, downloaded.bytes)) {
    try {
      const zip = new AdmZip(downloaded.bytes);
      const entries = zip.getEntries();
      const manifestLines = [
        `[ZIP] ${metadata.name ?? fileId} — ${entries.length} entries`,
        "",
        "Manifest (name, size, compressed):",
      ];
      for (const e of entries) {
        const n = e.entryName;
        const size = e.header?.size ?? 0;
        const csize = e.header?.compressedSize ?? 0;
        manifestLines.push(`  ${n}  (${size}B, ${csize}B compressed)`);
      }
      // Inline small text entries (≤ 64KB each, up to ~10 files)
      const INLINE_MAX = 64 * 1024;
      const INLINE_COUNT = 10;
      let inlined = 0;
      for (const e of entries) {
        if (inlined >= INLINE_COUNT) break;
        if (e.isDirectory) continue;
        const size = e.header?.size ?? 0;
        if (size > INLINE_MAX) continue;
        const ext = (e.entryName.split(".").pop() ?? "").toLowerCase();
        if (!TEXT_FILE_TYPES.has(ext)) continue;
        try {
          const data = e.getData().toString("utf8");
          manifestLines.push("", `--- ${e.entryName} ---`, data);
          inlined += 1;
        } catch {
          // skip unreadable entries
        }
      }
      if (inlined === 0) {
        manifestLines.push(
          "",
          "(No small text entries to inline. Use extract tooling in a followup tool call if needed.)",
        );
      }
      return {
        kind: "text",
        file: metadata,
        text: manifestLines.join("\n"),
        truncated: false,
        source: "zip-manifest",
      };
    } catch (err) {
      throw new Error(
        `ZIP read failed for ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Final fallback: UTF-8 sniff. If bytes decode cleanly with < 2% control chars, treat as text. ---
  if (looksLikeUtf8Text(downloaded.bytes)) {
    const text = downloaded.bytes.toString("utf8");
    return {
      kind: "text",
      file: metadata,
      text,
      truncated: false,
      source: "utf8-sniff",
    };
  }

  // Nothing usable — return a structured metadata description so the agent can decide what to do.
  throw new Error(
    `Unsupported Slack file type: ${file.mimetype ?? file.filetype ?? downloaded.mimeType} ` +
      `(${downloaded.bytes.length} bytes, name=${metadata.name ?? metadata.title ?? fileId}). ` +
      `Add support or route through bash tools with a manual download.`,
  );
}

function getInlineFileText(result: FilesInfoResponse, file: SlackFileObject): string | undefined {
  return result.content ?? file.plain_text ?? file.preview_plain_text ?? file.preview;
}

function toSlackFileMetadata(file: SlackFileObject): SlackFileMetadata {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    pretty_type: file.pretty_type,
    size: file.size,
    permalink: file.permalink,
    url_private: file.url_private,
    url_private_download: file.url_private_download,
  };
}

function isImageFile(file: SlackFileObject, mimeType?: string): boolean {
  return (mimeType ?? file.mimetype ?? "").startsWith("image/");
}

function isTextLikeFile(file: SlackFileObject, mimeType?: string): boolean {
  const effectiveMimeType = mimeType ?? file.mimetype ?? "";
  if (effectiveMimeType.startsWith("text/") || TEXT_MIME_TYPES.has(effectiveMimeType)) {
    return true;
  }
  const filetype = (file.filetype ?? "").toLowerCase();
  if (TEXT_FILE_TYPES.has(filetype)) return true;
  // Also sniff by filename extension (Slack's `filetype` is not always set)
  const name = (file.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > -1) {
    const ext = name.slice(dot + 1);
    if (TEXT_FILE_TYPES.has(ext)) return true;
  }
  return false;
}

function isPdfFile(file: SlackFileObject, mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "application/pdf") return true;
  if ((file.filetype ?? "").toLowerCase() === "pdf") return true;
  if ((file.mimetype ?? "") === "application/pdf") return true;
  // PDF magic: %PDF-
  return bytes.slice(0, 5).toString("ascii") === "%PDF-";
}

function isZipFile(file: SlackFileObject, mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "application/zip" || mimeType === "application/x-zip-compressed") return true;
  if ((file.filetype ?? "").toLowerCase() === "zip") return true;
  // ZIP magic: PK\x03\x04 or PK\x05\x06 (empty) or PK\x07\x08 (spanned)
  const magic = bytes.slice(0, 4).toString("hex");
  return magic === "504b0304" || magic === "504b0506" || magic === "504b0708";
}

/**
 * Heuristic: returns true if the buffer decodes as mostly-printable UTF-8.
 * Rejects anything with > 2% control chars (excluding \t, \n, \r) or invalid sequences.
 */
function looksLikeUtf8Text(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
    else if (code === 127) control += 1;
  }
  return control / text.length < 0.02;
}

async function downloadSlackFile(
  url: string,
  maxBytes: number,
  deps: SlackDeps,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!deps.token) {
    throw new Error("Slack bot token is required to download files");
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${deps.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new Error(`Slack file exceeds max_bytes (${contentLength} > ${maxBytes})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`Slack file exceeds max_bytes (${bytes.length} > ${maxBytes})`);
  }

  const rawContentType = response.headers.get("content-type") ?? "application/octet-stream";
  // Strip any charset/params: "image/png; charset=utf-8" -> "image/png"
  const mimeType = rawContentType.split(";")[0].trim().toLowerCase();
  // Magic-byte sniff for sanity (OpenAI rejects anything that's not a real image)
  const magic = bytes.slice(0, 8).toString("hex");
  // Strong signals:
  //   89504e47 = PNG,  ffd8ff = JPEG,  47494638 = GIF,  52494646...57454250 = WEBP
  let detected = "unknown";
  if (magic.startsWith("89504e47")) detected = "image/png";
  else if (magic.startsWith("ffd8ff")) detected = "image/jpeg";
  else if (magic.startsWith("47494638")) detected = "image/gif";
  else if (magic.startsWith("52494646") && bytes.slice(8, 12).toString("hex") === "57454250")
    detected = "image/webp";
  // If the CDN mime disagrees with the magic bytes, prefer the magic bytes —
  // OpenAI will reject otherwise.
  const finalMime = detected !== "unknown" ? detected : mimeType;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      name: "slack-mcp",
      event: "file_downloaded",
      bytes: bytes.length,
      rawContentType,
      parsedMime: mimeType,
      magicHex: magic,
      detectedMime: detected,
      finalMime,
    }),
  );

  return {
    bytes,
    mimeType: finalMime,
  };
}
