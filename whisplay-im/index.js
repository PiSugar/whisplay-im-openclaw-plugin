import { promises as fs } from "node:fs";
import path from "node:path";

const CHANNEL_ID = "whisplay-im";
const GATEWAY_LOG_DIR = "/tmp/openclaw";
const GATEWAY_LOG_FILE_PATTERN = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;
const PAIRING_CACHE_LIMIT = 256;
const INBOUND_CACHE_LIMIT = 512;

const pairingRelaySeen = new Map();
const inboundSeenByAccount = new Map();
const pollTickByAccount = new Map();
let pluginRuntime = null;

function getChannelRuntime() {
    if (!pluginRuntime?.channel) {
        throw new Error(
            "whisplay-im: plugin runtime not available — " +
            "ensure OpenClaw >= 2026.4 and plugin was registered via register(api)",
        );
    }
    return pluginRuntime.channel;
}

// Build a dispatcher that delivers each reply payload sequentially to the whisplay device.
function buildWhisplayDispatcher(deliverPayload) {
    let chainedPromise = Promise.resolve();
    const enqueue = (payload) => {
        chainedPromise = chainedPromise.then(() =>
            deliverPayload(payload).catch((err) => {
                console.warn(
                    `[whisplay-im] dispatcher delivery error: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }),
        );
        return true;
    };
    return {
        sendToolResult: () => true,
        sendBlockReply: enqueue,
        sendFinalReply: enqueue,
        waitForIdle: () => chainedPromise,
        getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        markComplete: () => {},
    };
}

function payloadToReplyText(payload) {
    const text = String(payload?.text ?? "").trim();
    if (text) {
        return text;
    }
    const mediaUrl = String(payload?.mediaUrl ?? "").trim();
    if (mediaUrl) {
        return mediaUrl;
    }
    const mediaUrls = Array.isArray(payload?.mediaUrls)
        ? payload.mediaUrls.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
    if (mediaUrls.length > 0) {
        return mediaUrls.join("\n");
    }
    return "";
}

function sanitizeInboundText(text) {
    let cleaned = String(text ?? "").trimStart();
    let changed = false;

    const leadingPatterns = [
        /^System:\s*\[[^\n]+\](?:\n(?!\n).*)*(?:\n\s*)+/,
        /^Conversation info \(untrusted metadata\):\s*\n```json[\s\S]*?\n```\s*(?:\n\s*)*/,
        /^Sender \(untrusted metadata\):\s*\n```json[\s\S]*?\n```\s*(?:\n\s*)*/,
        /^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}[^\]]+\]\s*/,
    ];

    while (cleaned) {
        let stripped = false;
        for (const pattern of leadingPatterns) {
            const next = cleaned.replace(pattern, "").trimStart();
            if (next !== cleaned) {
                cleaned = next;
                changed = true;
                stripped = true;
                break;
            }
        }
        if (!stripped) {
            break;
        }
    }

    if (!changed) {
        return { text: String(text ?? ""), changed: false };
    }

    return {
        text: cleaned || String(text ?? ""),
        changed: Boolean(cleaned),
    };
}

function toCleanText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = String(value).trim();
    return text;
}

function pickFirstText(...values) {
    for (const value of values) {
        const text = toCleanText(value);
        if (text) {
            return text;
        }
    }
    return "";
}

function resolveInboundPeer(inbound) {
    const raw = inbound?.raw ?? {};
    const peerId = pickFirstText(
        raw.senderId,
        raw.sender,
        raw.from,
        raw.fromId,
        raw.userId,
        raw.uid,
        raw.sessionId,
        raw.session,
        raw.chatId,
        raw.chat,
        raw.deviceId,
        raw.device,
        raw.peerId,
        raw.peer,
        inbound?.id,
    );
    const peerName = pickFirstText(
        raw.senderName,
        raw.name,
        raw.nickname,
        raw.displayName,
        raw.userName,
        raw.username,
        raw.deviceName,
        peerId,
    );
    return {
        id: peerId || "whisplay",
        name: peerName || "whisplay",
    };
}

function getPairingSeenSet(accountId) {
    const key = String(accountId ?? "default");
    let seen = pairingRelaySeen.get(key);
    if (!seen) {
        seen = new Set();
        pairingRelaySeen.set(key, seen);
    }
    return seen;
}

function rememberPairingKey(seen, value) {
    seen.add(value);
    if (seen.size <= PAIRING_CACHE_LIMIT) {
        return;
    }
    const overflow = seen.size - PAIRING_CACHE_LIMIT;
    const iterator = seen.values();
    for (let index = 0; index < overflow; index += 1) {
        const first = iterator.next();
        if (first.done) {
            break;
        }
        seen.delete(first.value);
    }
}

function getInboundSeenSet(accountId) {
    const key = String(accountId ?? "default");
    let seen = inboundSeenByAccount.get(key);
    if (!seen) {
        seen = new Set();
        inboundSeenByAccount.set(key, seen);
    }
    return seen;
}

function rememberInboundKey(seen, value) {
    seen.add(value);
    if (seen.size <= INBOUND_CACHE_LIMIT) {
        return;
    }
    const overflow = seen.size - INBOUND_CACHE_LIMIT;
    const iterator = seen.values();
    for (let index = 0; index < overflow; index += 1) {
        const first = iterator.next();
        if (first.done) {
            break;
        }
        seen.delete(first.value);
    }
}

function buildInboundDedupeKey(inbound) {
    const peer = resolveInboundPeer(inbound);
    const peerPart = peer?.id ? `peer:${peer.id}` : "";
    const idPart = inbound.id ? `id:${inbound.id}` : "";
    if (idPart) {
        return [idPart, peerPart].filter(Boolean).join("|");
    }

    const tsPart = inbound.timestamp ? `ts:${inbound.timestamp}` : "";
    if (tsPart) {
        const textPart = `text:${String(inbound.text ?? "").trim()}`;
        return [tsPart, peerPart, textPart].filter(Boolean).join("|");
    }

    return "";
}

function nextPollTick(accountId) {
    const key = String(accountId ?? "default");
    const current = pollTickByAccount.get(key) ?? 0;
    const next = current + 1;
    pollTickByAccount.set(key, next);
    return next;
}

async function findLatestGatewayLogFile() {
    let entries;
    try {
        entries = await fs.readdir(GATEWAY_LOG_DIR, { withFileTypes: true });
    } catch {
        return null;
    }

    const candidates = entries
        .filter((entry) => entry.isFile() && GATEWAY_LOG_FILE_PATTERN.test(entry.name))
        .map((entry) => path.join(GATEWAY_LOG_DIR, entry.name));

    if (candidates.length === 0) {
        return null;
    }

    const stats = await Promise.all(
        candidates.map(async (filePath) => {
            try {
                const stat = await fs.stat(filePath);
                return { filePath, mtimeMs: stat.mtimeMs };
            } catch {
                return null;
            }
        }),
    );

    const sorted = stats
        .filter(Boolean)
        .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return sorted[0]?.filePath ?? null;
}

async function readTailText(filePath, maxBytes = 128 * 1024) {
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        return "";
    }

    if (!stat.isFile() || stat.size <= 0) {
        return "";
    }

    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return buffer.toString("utf8");
    } finally {
        await handle.close();
    }
}

function extractPairingAlerts(logText, options = {}) {
    if (!logText) {
        return [];
    }

    const lines = logText.split(/\r?\n/).filter(Boolean);
    const alerts = [];

    const recentThresholdMs =
        typeof options.notBeforeMs === "number" && Number.isFinite(options.notBeforeMs)
            ? options.notBeforeMs
            : Date.now() - 15 * 60 * 1000;

    for (const line of lines) {
        if (!line.includes("pairing-required") && !line.toLowerCase().includes("setup code")) {
            continue;
        }

        const timeMatch = line.match(/"time":"([^"]+)"/);
        if (timeMatch) {
            const ts = Date.parse(timeMatch[1]);
            if (Number.isFinite(ts) && ts < recentThresholdMs) {
                continue;
            }
        }

        const requestMatch = line.match(/"requestId":"([0-9a-f-]{16,})"/i);
        if (requestMatch) {
            const requestId = requestMatch[1];
            alerts.push({
                dedupeKey: `request:${requestId}`,
                message:
                    `Gateway detected a new pairing request.\n` +
                    `requestId: ${requestId}\n` +
                    `Please approve this request in OpenClaw console under Devices/Approvals.`,
            });
            continue;
        }

        const setupMatch = line.match(/setup code[^A-Za-z0-9]*([A-Z0-9-]{4,})/i);
        if (setupMatch) {
            const setupCode = setupMatch[1];
            alerts.push({
                dedupeKey: `setup:${setupCode}`,
                message: `Gateway pairing code: ${setupCode}`,
            });
            continue;
        }
    }

    return alerts;
}

function resolveAccountSection(cfg, accountId) {
    const section = cfg?.channels?.[CHANNEL_ID] ?? {};
    const accountKey = accountId ?? "default";
    const accounts = normalizeAccountsConfig(section?.accounts);
    const accountSection = accounts[accountKey] && typeof accounts[accountKey] === "object" ? accounts[accountKey] : {};
    const hasLegacyTopLevelDeviceConfig =
        typeof section?.ip === "string" ||
        typeof section?.token === "string" ||
        typeof section?.waitSec === "number";
    return {
        enabled: section?.enabled !== false,
        ...(accountSection && typeof accountSection === "object" ? accountSection : {}),
        accountId: accountKey,
        hasAccountSection: Boolean(accountSection && typeof accountSection === "object" && Object.keys(accountSection).length > 0),
        hasLegacyTopLevelDeviceConfig,
    };
}

function normalizeAccountsConfig(accountsValue) {
    if (!accountsValue) {
        return {};
    }

    if (Array.isArray(accountsValue)) {
        const normalized = {};
        for (let index = 0; index < accountsValue.length; index += 1) {
            const entry = accountsValue[index];
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
            const fallbackId = index === 0 ? "default" : `account-${index + 1}`;
            const id = rawId || fallbackId;
            normalized[id] = {
                ...entry,
                id,
            };
        }
        return normalized;
    }

    return typeof accountsValue === "object" ? accountsValue : {};
}

function buildAccountConfigError(accountId, account) {
    const prefix = `whisplay-im account "${accountId}" is not configured`;
    const guidance =
        `Configure channels.${CHANNEL_ID}.accounts.${accountId}.ip (and optional token/waitSec). ` +
        `Top-level channels.${CHANNEL_ID}.ip/token/waitSec are not supported.`;
    if (account?.hasLegacyTopLevelDeviceConfig) {
        return `${prefix}: detected legacy top-level device fields. ${guidance}`;
    }
    return `${prefix}: missing accounts.${accountId}.ip. ${guidance}`;
}

function normalizeBaseUrl(ip) {
    const raw = String(ip ?? "").trim();
    if (!raw) {
        return "";
    }
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
        return raw.replace(/\/$/, "");
    }
    return `http://${raw.replace(/\/$/, "")}`;
}

function buildHeaders(token) {
    const headers = { "Content-Type": "application/json" };
    const t = String(token ?? "").trim();
    if (t) {
        headers.Authorization = `Bearer ${t}`;
    }
    return headers;
}

async function fetchImageAsBase64(url) {
    if (!url) return "";
    // Already a data URL
    if (url.startsWith("data:")) return url;
    try {
        const response = await fetch(url);
        if (!response.ok) return "";
        const contentType = response.headers.get("content-type") || "image/jpeg";
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        return `data:${contentType};base64,${base64}`;
    } catch (err) {
        return "";
    }
}

async function sendStatus(baseUrl, token, status, extra = {}) {
    const body = { status, ...extra };
    const url = `${baseUrl}/whisplay-im/status`;
    console.warn(`[sendStatus] POST ${url} status=${status} ${extra.tool ? `tool=${extra.tool}` : ''} ${extra.emoji || ''}`);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: buildHeaders(token),
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const respBody = await response.text().catch(() => "");
            console.warn(`[sendStatus] FAILED: HTTP ${response.status}${respBody ? ` ${respBody}` : ""}`);
        } else {
            console.warn(`[sendStatus] OK: ${response.status}`);
        }
    } catch (err) {
        console.warn(`[sendStatus] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function sendReply(baseUrl, token, reply, imageBase64) {
    const body = { reply, emoji: "😊" };
    if (imageBase64) {
        body.imageBase64 = imageBase64;
    }
    const response = await fetch(`${baseUrl}/whisplay-im/send`, {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const respBody = await response.text().catch(() => "");
        throw new Error(`whisplay-im send failed: HTTP ${response.status}${respBody ? ` ${respBody}` : ""}`);
    }

    return { ok: true, channel: CHANNEL_ID };
}

function normalizeInboundItems(payload) {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const topLevelImageBase64 = typeof payload.imageBase64 === "string" ? payload.imageBase64.trim() : "";
    const results = [];
    const list = Array.isArray(payload.messages) ? payload.messages : [];

    if (list.length > 0) {
        for (const item of list) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const text =
                typeof item.content === "string"
                    ? item.content
                    : typeof item.message === "string"
                        ? item.message
                        : "";
            if (!text.trim()) {
                continue;
            }
            const itemImageBase64 = typeof item.imageBase64 === "string" ? item.imageBase64.trim() : "";
            results.push({
                text,
                imageBase64: itemImageBase64 || topLevelImageBase64,
                id:
                    typeof item.id === "string" || typeof item.id === "number"
                        ? String(item.id)
                        : "",
                timestamp:
                    typeof item.timestamp === "string" || typeof item.timestamp === "number"
                        ? String(item.timestamp)
                        : "",
                raw: item,
            });
        }
        return results;
    }

    const single = typeof payload.message === "string" ? payload.message : "";
    if (single.trim()) {
        results.push({ text: single, imageBase64: topLevelImageBase64, id: "", timestamp: "", raw: payload });
    }
    return results;
}

async function emitInboundToGateway(ctx, inbound) {
    const channelRuntime = getChannelRuntime();
    const peer = resolveInboundPeer(inbound);
    const senderId = peer.id;
    const accountLabel = toCleanText(ctx.accountId ?? ctx.account?.accountId ?? ctx.account?.id);
    const senderName = `${peer.name}(${accountLabel || "unknown"})`;
    const sanitizedInbound = sanitizeInboundText(inbound.text);
    if (sanitizedInbound.changed) {
        console.warn(
            `[whisplay-im] sanitized inbound text for ${senderName}: ` +
            `${JSON.stringify(String(inbound.text || "").slice(0, 160))} -> ` +
            `${JSON.stringify(String(sanitizedInbound.text || "").slice(0, 160))}`,
        );
    }
    const tsNumber = Number(inbound.timestamp);
    const parsedTimestamp = Number.isFinite(tsNumber) ? tsNumber : Date.now();

    // Use framework routing instead of hardcoded session keys
    const route = channelRuntime.routing.resolveAgentRoute({
        cfg: ctx.cfg,
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        peer: { kind: "direct", id: senderId || "whisplay" },
    });

    const inboundCtx = {
        Body: sanitizedInbound.text,
        BodyForAgent: sanitizedInbound.text,
        BodyForCommands: sanitizedInbound.text,
        RawBody: sanitizedInbound.text,
        CommandBody: sanitizedInbound.text,
        SessionKey: route.sessionKey,
        AccountId: ctx.accountId,
        ConversationLabel: senderName || undefined,
        SenderName: senderName || undefined,
        Timestamp: parsedTimestamp,
        From: senderId || undefined,
        To: senderId || undefined,
        ChatType: "direct",
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: senderId || undefined,
        CommandAuthorized: true,
        ...(inbound.imageBase64 ? { MediaUrl: inbound.imageBase64 } : {}),
    };

    const baseUrl = normalizeBaseUrl(ctx.account?.ip);
    const accountToken = ctx.account?.token;

    // Send "thinking" status before agent processes the message
    await sendStatus(baseUrl, accountToken, "thinking", { emoji: "🤔", text: sanitizedInbound.text.slice(0, 80) });

    let sentCount = 0;

    // Build a sequential dispatcher that sends each reply to the whisplay device.
    const dispatcher = buildWhisplayDispatcher(async (payload) => {
        const text = String(payload?.text ?? "").trim();
        const mediaUrl = String(payload?.mediaUrl ?? "").trim();
        const mediaUrls = Array.isArray(payload?.mediaUrls)
            ? payload.mediaUrls.map((v) => String(v ?? "").trim()).filter(Boolean)
            : [];
        const firstMediaUrl = mediaUrl || (mediaUrls.length > 0 ? mediaUrls[0] : "");
        const replyText = text || (firstMediaUrl ? "" : payloadToReplyText(payload));

        // Convert media URL to base64 if present
        let imageBase64 = "";
        if (firstMediaUrl) {
            await sendStatus(baseUrl, accountToken, "tool_calling", {
                emoji: "🖼️",
                tool: "fetchImage",
                text: "Downloading image...",
            });
            imageBase64 = await fetchImageAsBase64(firstMediaUrl);
        }

        if (!replyText && !imageBase64) {
            return;
        }

        // Send "answering" status before delivering the reply
        if (replyText) {
            await sendStatus(baseUrl, accountToken, "answering");
        }
        await sendReply(baseUrl, accountToken, replyText, imageBase64 || undefined);
        sentCount += 1;
    });

    // Dispatch using channelRuntime (following openclaw-weixin pattern)
    await channelRuntime.reply.withReplyDispatcher({
        dispatcher,
        onSettled: async () => {
            // All deliveries are complete (waitForIdle resolved) before onSettled is called.
            await sendStatus(baseUrl, accountToken, "idle");
        },
        run: () =>
            channelRuntime.reply.dispatchReplyFromConfig({
                ctx: inboundCtx,
                cfg: ctx.cfg,
                dispatcher,
                replyOptions: {
                    onToolStart: ({ name, phase }) => {
                        if (phase === "end") {
                            sendStatus(baseUrl, accountToken, "tool_calling", {
                                emoji: "✅",
                                tool: name || "tool",
                                text: `${name || "tool"} done`,
                            }).catch(() => {});
                        } else {
                            sendStatus(baseUrl, accountToken, "tool_calling", {
                                emoji: "🔧",
                                tool: name || "tool",
                                text: `Invoking ${name || "tool"}...`,
                            }).catch(() => {});
                        }
                    },
                },
            }),
    });

    if (sentCount > 0) {
        ctx.setStatus({
            ...ctx.getStatus(),
            accountId: ctx.accountId,
            running: true,
            configured: true,
            mode: "poll",
            lastOutboundAt: Date.now(),
            lastError: null,
        });
    }

    return "channelRuntime.reply.dispatchReplyFromConfig";
}

async function relayGatewayPairingHints({ accountId, baseUrl, token, log, notBeforeMs }) {
    const logFile = await findLatestGatewayLogFile();
    if (!logFile) {
        return;
    }

    const tail = await readTailText(logFile);
    if (!tail) {
        return;
    }

    const alerts = extractPairingAlerts(tail, { notBeforeMs });
    if (alerts.length === 0) {
        return;
    }

    const seen = getPairingSeenSet(accountId);
    for (const alert of alerts) {
        if (seen.has(alert.dedupeKey)) {
            continue;
        }
        await sendReply(baseUrl, token, alert.message);
        rememberPairingKey(seen, alert.dedupeKey);
        log?.info?.(`[${accountId}] relayed gateway pairing hint: ${alert.dedupeKey}`);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const whisplayImChannel = {
    id: CHANNEL_ID,
    meta: {
        id: CHANNEL_ID,
        label: "Whisplay IM",
        selectionLabel: "Whisplay IM (HTTP bridge)",
        docsPath: "/channels/whisplay-im",
        blurb: "Whisplay IM bridge channel via poll/send endpoints.",
        aliases: ["whisplayim"],
    },
    capabilities: {
        chatTypes: ["direct"],
        reactions: false,
        threads: false,
        media: true,
        nativeCommands: false,
        blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.whisplay-im"] },
    configSchema: {
        schema: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: { type: "boolean" },
                accounts: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: { type: "string" },
                            enabled: { type: "boolean" },
                            ip: { type: "string" },
                            token: { type: "string" },
                            waitSec: { type: "number" },
                        },
                    },
                }
            }
        }
    },
    config: {
        listAccountIds: (cfg) => {
            const section = cfg?.channels?.[CHANNEL_ID] ?? {};
            const accounts = normalizeAccountsConfig(section?.accounts);
            const keys = Object.keys(accounts).filter(Boolean);
            return keys.length > 0 ? keys : ["default"];
        },
        defaultAccountId: (cfg) => {
            const section = cfg?.channels?.[CHANNEL_ID] ?? {};
            const accounts = normalizeAccountsConfig(section?.accounts);
            return Object.prototype.hasOwnProperty.call(accounts, "default")
                ? "default"
                : (Object.keys(accounts)[0] ?? "default");
        },
        resolveAccount: (cfg, accountId) => {
            const effective = resolveAccountSection(cfg, accountId);
            return {
                accountId: effective.accountId,
                enabled: effective?.enabled !== false,
                ip: typeof effective?.ip === "string" ? effective.ip : "",
                token: typeof effective?.token === "string" ? effective.token : "",
                waitSec:
                    typeof effective?.waitSec === "number" && Number.isFinite(effective.waitSec)
                        ? effective.waitSec
                        : 60,
                configured:
                    effective?.hasAccountSection === true &&
                    typeof effective?.ip === "string" &&
                    effective.ip.trim().length > 0,
            };
        },
        isConfigured: (account) => Boolean(account?.configured),
        describeAccount: (account) => ({
            accountId: account?.accountId ?? "default",
            enabled: account?.enabled !== false,
            configured: Boolean(account?.configured),
            ip: account?.ip ? "[set]" : "[missing]",
            token: account?.token ? "[set]" : "[empty]",
            waitSec: account?.waitSec ?? 60,
        }),
    },
    messaging: {
        normalizeTarget: (raw) => {
            const value = String(raw ?? "").trim();
            if (!value) {
                return undefined;
            }
            return value.replace(/^whisplay-im:/i, "");
        },
        targetResolver: {
            looksLikeId: (raw) => String(raw ?? "").trim().length > 0,
            hint: "<device-or-session-id>",
        },
    },
    outbound: {
        deliveryMode: "direct",
        sendText: async ({ cfg, accountId, text }) => {
            const account = resolveAccountSection(cfg, accountId);
            const baseUrl = normalizeBaseUrl(account.ip);
            if (!baseUrl) {
                throw new Error(buildAccountConfigError(account.accountId ?? accountId ?? "default", account));
            }

            return sendReply(baseUrl, account.token, text, undefined);
        },
        sendMedia: async ({ cfg, accountId, text, mediaUrl, mediaUrls }) => {
            const caption = String(text ?? "").trim();
            const media = String(mediaUrl ?? "").trim();
            const mediaList = Array.isArray(mediaUrls)
                ? mediaUrls.map((v) => String(v ?? "").trim()).filter(Boolean)
                : [];
            const firstMediaUrl = media || (mediaList.length > 0 ? mediaList[0] : "");

            const account = resolveAccountSection(cfg, accountId);
            const baseUrl = normalizeBaseUrl(account.ip);
            if (!baseUrl) {
                throw new Error(buildAccountConfigError(account.accountId ?? accountId ?? "default", account));
            }

            // Convert media URL to base64 for transmission
            let imageBase64 = "";
            if (firstMediaUrl) {
                imageBase64 = await fetchImageAsBase64(firstMediaUrl);
            }

            return sendReply(baseUrl, account.token, caption, imageBase64 || undefined);
        },
    },
    status: {
        defaultRuntime: {
            accountId: "default",
            running: false,
            configured: false,
            lastStartAt: null,
            lastStopAt: null,
            lastInboundAt: null,
            lastOutboundAt: null,
            lastError: null,
            mode: "poll",
        },
        buildAccountSnapshot: ({ account, runtime }) => ({
            accountId: account?.accountId ?? "default",
            enabled: account?.enabled !== false,
            configured: Boolean(account?.configured),
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastInboundAt: runtime?.lastInboundAt ?? null,
            lastOutboundAt: runtime?.lastOutboundAt ?? null,
            lastError: runtime?.lastError ?? null,
            mode: "poll",
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const account = resolveAccountSection(ctx.cfg, ctx.accountId);
            const baseUrl = normalizeBaseUrl(account.ip);
            if (!baseUrl) {
                throw new Error(buildAccountConfigError(ctx.accountId, account));
            }

            const isAborted = () => Boolean(ctx.abortSignal && ctx.abortSignal.aborted);
            ctx.log?.warn?.(`[${ctx.accountId}] inbound dispatcher source: channelRuntime.reply`);
            const channelRuntime = getChannelRuntime();
            ctx.log?.warn?.(`[${ctx.accountId}] inbound dispatcher preflight: channelRuntime.reply ready`);
            ctx.setStatus({
                accountId: ctx.accountId,
                configured: true,
                running: true,
                mode: "poll",
                lastStartAt: Date.now(),
                lastError: null,
            });

            try {
                const relayStartAtMs = Date.now();
                const pairingWatcher = (async () => {
                    while (!isAborted()) {
                        try {
                            await relayGatewayPairingHints({
                                accountId: ctx.accountId,
                                baseUrl,
                                token: account.token,
                                log: ctx.log,
                                notBeforeMs: relayStartAtMs,
                            });
                        } catch (error) {
                            ctx.log?.warn?.(
                                `[${ctx.accountId}] pairing hint relay failed: ${error instanceof Error ? error.message : String(error)}`,
                            );
                        }
                        await sleep(5000);
                    }
                })();

                while (!isAborted()) {
                    try {
                        const waitSec =
                            typeof account.waitSec === "number" && Number.isFinite(account.waitSec)
                                ? account.waitSec
                                : 60;
                        const requestInit = {
                            method: "GET",
                            headers: buildHeaders(account.token),
                        };
                        if (ctx.abortSignal) {
                            requestInit.signal = ctx.abortSignal;
                        }
                        const response = await fetch(
                            `${baseUrl}/whisplay-im/poll?waitSec=${encodeURIComponent(String(waitSec))}`,
                            requestInit,
                        );
                        if (!response.ok) {
                            const body = await response.text().catch(() => "");
                            throw new Error(`poll failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
                        }
                        const payload = await response.json().catch(() => ({}));
                        const pollTick = nextPollTick(ctx.accountId);
                        const inbounds = normalizeInboundItems(payload);
                        if (inbounds.length > 0) {
                            ctx.log?.warn?.(
                                `[${ctx.accountId}] poll received ${inbounds.length} inbound message(s)`,
                            );
                            const seen = getInboundSeenSet(ctx.accountId);
                            for (const inbound of inbounds) {
                                const dedupeKey = buildInboundDedupeKey(inbound);
                                if (dedupeKey && seen.has(dedupeKey)) {
                                    ctx.log?.warn?.(
                                        `[${ctx.accountId}] inbound dropped as duplicate: ${dedupeKey}`,
                                    );
                                    continue;
                                }
                                const methodName = await emitInboundToGateway(ctx, inbound);
                                if (dedupeKey) {
                                    rememberInboundKey(seen, dedupeKey);
                                }
                                ctx.log?.debug?.(
                                    `[${ctx.accountId}] inbound relayed via ${methodName}: ${inbound.text.slice(0, 120)}`,
                                );
                            }
                            ctx.setStatus({
                                ...ctx.getStatus(),
                                accountId: ctx.accountId,
                                running: true,
                                configured: true,
                                mode: "poll",
                                lastInboundAt: Date.now(),
                                lastError: null,
                            });
                        } else {
                            ctx.log?.warn?.(
                                `[${ctx.accountId}] poll active: no inbound messages yet (ticks=${pollTick})`,
                            );
                        }
                    } catch (error) {
                        if (isAborted()) {
                            break;
                        }
                        ctx.log?.warn?.(
                            `[${ctx.accountId}] poll loop error: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        ctx.setStatus({
                            ...ctx.getStatus(),
                            accountId: ctx.accountId,
                            running: true,
                            configured: true,
                            mode: "poll",
                            lastError: error instanceof Error ? error.message : String(error),
                        });
                        await sleep(2000);
                    }
                }
                await pairingWatcher.catch(() => { });
            } finally {
                ctx.setStatus({
                    ...ctx.getStatus(),
                    accountId: ctx.accountId,
                    running: false,
                    lastStopAt: Date.now(),
                });
            }
        },
    },
};

const plugin = {
    id: CHANNEL_ID,
    name: "Whisplay IM",
    description: "Whisplay IM bridge channel plugin",
    register(api) {
        pluginRuntime = api.runtime;
        api.registerChannel({ plugin: whisplayImChannel });
    },
};

export default plugin;
