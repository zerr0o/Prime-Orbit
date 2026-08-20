"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function normalizedFile(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const ORBIT_BOUNDARY = /<prime_orbit_ui_boundary v="1" id="([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})" visible_utf16="(\d+)"\/>$/;
const ORBIT_MANIFEST_PREFIX = '<prime_orbit_manifest encoding="base64url">';
const ORBIT_MANIFEST_CLOSE = '</prime_orbit_manifest>\n';
const MAX_MANIFEST_ENCODED_CHARS = 87_382;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ATTACHMENT_COUNT = 20;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_FRAGMENT_UTF16 = 16 * 1024 * 1024;

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validManifestName(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 2_048
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0xd800 && codePoint <= 0xdfff;
    })
    && !/[\\/\p{Cc}]/u.test(value);
}

function validManifestMime(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0xd800 && codePoint <= 0xdfff;
    })
    && !/\p{Cc}/u.test(value);
}

function parseOrbitManifest(encoded) {
  if (typeof encoded !== "string"
      || encoded.length === 0
      || encoded.length > MAX_MANIFEST_ENCODED_CHARS
      || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > MAX_MANIFEST_BYTES || bytes.toString("base64url") !== encoded) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_ATTACHMENT_COUNT) return undefined;
  let total = 0;
  for (const attachment of manifest) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return undefined;
    if (Object.keys(attachment).sort().join(",") !== "isImage,mimeType,name,size") return undefined;
    if (attachment.isImage !== false
        || !validManifestName(attachment.name)
        || !validManifestMime(attachment.mimeType)
        || !Number.isSafeInteger(attachment.size)
        || attachment.size < 0
        || attachment.size > MAX_DOCUMENT_BYTES) return undefined;
    total += attachment.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_ATTACHMENT_BYTES) return undefined;
  }
  return manifest;
}

function fragmentsMatchManifest(fragments, manifest) {
  let remaining = fragments;
  for (let index = 0; index < manifest.length; index += 1) {
    const opener = `<file name="${xmlEscape(manifest[index].name)}" content_utf16="`;
    if (!remaining.startsWith(opener)) return false;
    const lengthEnd = remaining.indexOf('\">\n', opener.length);
    if (lengthEnd < 0) return false;
    const encodedLength = remaining.slice(opener.length, lengthEnd);
    if (!/^(0|[1-9]\d*)$/u.test(encodedLength)) return false;
    const contentLength = Number(encodedLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_FRAGMENT_UTF16) return false;
    const bodyStart = lengthEnd + 3;
    const bodyEnd = bodyStart + contentLength;
    if (bodyEnd > remaining.length || remaining.slice(bodyEnd, bodyEnd + 8) !== "\n</file>") return false;
    remaining = remaining.slice(bodyEnd + 8);
    if (index + 1 < manifest.length) {
      if (!remaining.startsWith("\n")) return false;
      remaining = remaining.slice(1);
    }
  }
  return remaining.length === 0;
}

function parseOrbitAttachmentEnvelope(value) {
  if (typeof value !== "string") return undefined;
  const boundary = ORBIT_BOUNDARY.exec(value);
  if (!boundary) return undefined;
  const id = boundary[1];
  const visibleLength = Number(boundary[2]);
  if (!Number.isSafeInteger(visibleLength)
      || String(visibleLength) !== boundary[2]
      || visibleLength < 0
      || visibleLength > value.length) return undefined;
  const separator = visibleLength === 0 ? "" : "\n\n";
  const suffix = value.slice(visibleLength);
  const opener = `${separator}<prime_orbit_attachment_context v="1" id="${id}">\n`;
  const closer = `\n</prime_orbit_attachment_context>\n${boundary[0]}`;
  if (!suffix.startsWith(opener) || !suffix.endsWith(closer)) return undefined;
  const contextBody = suffix.slice(opener.length, -closer.length);
  if (!contextBody.startsWith(ORBIT_MANIFEST_PREFIX)) return undefined;
  const manifestEnd = contextBody.indexOf(ORBIT_MANIFEST_CLOSE, ORBIT_MANIFEST_PREFIX.length);
  if (manifestEnd < 0) return undefined;
  const encodedManifest = contextBody.slice(ORBIT_MANIFEST_PREFIX.length, manifestEnd);
  const manifest = parseOrbitManifest(encodedManifest);
  if (!manifest) return undefined;
  const fragments = contextBody.slice(manifestEnd + ORBIT_MANIFEST_CLOSE.length);
  if (!fragmentsMatchManifest(fragments, manifest)) return undefined;
  return { id, visible: value.slice(0, visibleLength), separator, suffix };
}

function replacementPreservingOrbitEnvelope(replacement, parsed) {
  if (!parsed) return replacement;
  const envelope = parsed.suffix.slice(parsed.separator.length).replace(
    ORBIT_BOUNDARY,
    `<prime_orbit_ui_boundary v="1" id="${parsed.id}" visible_utf16="${replacement.length}"/>`,
  );
  return `${replacement}${replacement.length === 0 ? "" : "\n\n"}${envelope}`;
}

function findDaemonModules(cliPath) {
  let cursor = path.dirname(cliPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const daemonClient = path.join(cursor, "modes", "daemon", "daemon-client.js");
    const daemonSocket = path.join(cursor, "modes", "daemon", "daemon-socket.js");
    if (fs.existsSync(daemonClient) && fs.existsSync(daemonSocket)) {
      return { daemonClient, daemonSocket };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("Les modules daemon de Prime Agent sont introuvables dans ce runtime.");
}

async function main() {
  const cliPath = process.env.PRIME_ORBIT_CLI_PATH;
  const chunks = [];
  let requestBytes = 0;
  for await (const chunk of process.stdin) {
    requestBytes += chunk.length;
    if (requestBytes > 512 * 1024) throw new Error("La requête de mutation de file est trop volumineuse.");
    chunks.push(chunk);
  }
  const requestText = Buffer.concat(chunks).toString("utf8");
  if (!cliPath || !requestText) throw new Error("Requête de mutation de file incomplète.");
  const request = JSON.parse(requestText);
  const modules = findDaemonModules(cliPath);
  const [{ DaemonClient }, { defaultDaemonSocketPath }] = await Promise.all([
    import(pathToFileURL(modules.daemonClient).href),
    import(pathToFileURL(modules.daemonSocket).href),
  ]);

  const client = new DaemonClient(defaultDaemonSocketPath());
  try {
    await client.connect(3_000);
    await client.waitForHello(3_000);
    if (!client.supportsServerCapability("queue_message_mutation")) {
      process.stdout.write(JSON.stringify({ status: "unsupported" }));
      return;
    }

    const list = await client.request({ type: "list", all: true, includeClientOwned: true }, 5_000);
    if (!list.success) throw new Error(list.error || "Prime Agent a refusé de lister les sessions.");
    const sessions = Array.isArray(list.data?.sessions) ? list.data.sessions : [];
    const expectedFile = normalizedFile(request.sessionFile);
    let session;
    if (typeof request.sessionId === "string" && request.sessionId) {
      session = sessions.find((item) => item?.sessionId === request.sessionId && item?.activeSessionId);
    }
    if (!session && expectedFile) {
      session = sessions.find((item) => normalizedFile(item?.sessionFile) === expectedFile && item?.activeSessionId);
    }
    if (!session?.activeSessionId) {
      throw new Error("La session Prime Agent n’est pas active dans le daemon.");
    }

    const state = await client.request({
      type: "get_state",
      activeSessionId: session.activeSessionId,
    }, 5_000);
    if (!state.success) throw new Error(state.error || "Prime Agent n’a pas pu relire la file active.");
    const queue = request.lane === "steering"
      ? state.data?.sessionActions?.steering
      : request.lane === "followUp"
        ? state.data?.sessionActions?.followUps
        : undefined;
    const rawExpectedText = Array.isArray(queue) ? queue[request.index] : undefined;
    if (typeof rawExpectedText !== "string") {
      process.stdout.write(JSON.stringify({ status: "rejected" }));
      return;
    }
    const parsedEnvelope = parseOrbitAttachmentEnvelope(rawExpectedText);
    const visibleExpectedText = parsedEnvelope?.visible ?? rawExpectedText;
    if (request.expectedText !== visibleExpectedText && request.expectedText !== rawExpectedText) {
      process.stdout.write(JSON.stringify({ status: "rejected" }));
      return;
    }
    const effectiveMutation = request.mutation?.type === "replace" && typeof request.mutation.text === "string"
      ? {
          ...request.mutation,
          text: replacementPreservingOrbitEnvelope(request.mutation.text, parsedEnvelope),
        }
      : request.mutation;

    const mutation = await client.request({
      type: "mutate_queued_message",
      activeSessionId: session.activeSessionId,
      lane: request.lane,
      index: request.index,
      expectedText: rawExpectedText,
      mutation: effectiveMutation,
    }, 5_000);
    if (!mutation.success) throw new Error(mutation.error || "Prime Agent a refusé la mutation de file.");
    const status = mutation.data?.status;
    if (!["applied", "rejected", "invalid"].includes(status)) {
      throw new Error("Réponse de mutation de file invalide.");
    }

    process.stdout.write(JSON.stringify({
      status,
      ...(parsedEnvelope?.id ? { attachmentContextId: parsedEnvelope.id } : {}),
    }));
  } finally {
    client.close();
  }
}

const hardTimeout = setTimeout(() => {
  fail("La mutation de file Prime Agent a dépassé 20 secondes.");
  process.exit(1);
}, 20_000);

main()
  .then(() => clearTimeout(hardTimeout))
  .catch((error) => {
    clearTimeout(hardTimeout);
    fail(error instanceof Error ? error.message : String(error));
  });
