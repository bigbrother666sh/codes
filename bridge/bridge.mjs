/**
 * Feishu ↔ Codex Bridge
 *
 * Drives one Codex CLI `app-server` subprocess per conversation and bridges its
 * full IO to Feishu bots (the interaction UI). Codex is OpenAI's open-source
 * coding agent; the app-server subcommand exposes a JSON-RPC 2.0 stdio
 * protocol (JSONL framing) that supports streaming deltas, interrupts,
 * structured approvals and cross-process thread resume.
 *
 * Architecture:
 *   bridge.mjs (single Node.js process)
 *     ├── loadBridgeConfig() — reads ~/.codes/bridge.json
 *     ├── Uses the local Codex configuration and default home unchanged
 *     ├── CodexAppServer (one per conversation) — manages codex subprocess
 *     │     ├── spawn: codex app-server (stdio JSON-RPC, JSONL)
 *     │     ├── initialize → thread/start | thread/resume (session = thread id)
 *     │     ├── turn/start sends user text; item/agentMessage/delta streams
 *     │     │   the answer; turn/completed ends the turn
 *     │     ├── turn/interrupt cancels an in-flight turn
 *     │     └── respawn: next message re-initializes and resumes the thread
 *     └── FeishuBot (one per bot app) — manages Feishu WebSocket connection
 *           ├── createLarkChannel (one per bot app)
 *           ├── channel.on({ message, cardAction, ... })
 *           └── channel.send / channel.stream replies
 *
 * Config: ~/.codes/bridge.json
 * Sessions: ~/.codes/bridge-sessions.json (auto-saved)
 * Codex home: local default (~/.codex), or inherited CODEX_HOME; never generated
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import util from 'node:util';
import {
  indexBotProjects, conversationKey, isBotMentioned, isOwnMessage,
  groupMessageRecord, buildGroupPrompt, GroupMessageBuffer,
} from './conversations.mjs';
import { BridgeNoticeRegistry } from './notices.mjs';

// ─── Console timestamp + rotating-file logging ─────────────────
// loguru-style size rotation, zero deps, in-process: console.* is redirected
// to rotating files in ~/.codes/logs (roll at MAX_BYTES, keep MAX_FILES
// generations). systemd ships stdout/stderr to the journal (crash fallback);
// it no longer appends to these files — the bridge owns them now, so it can
// rotate them without fighting systemd's held fd.
{
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  // Baseline: timestamp-prefixed REAL console → systemd journal. Always
  // installed first; if rotating-file setup throws, this stays in effect so
  // we never lose logging entirely. Crash output also lands here.
  const real = {
    log: console.log.bind(console), info: console.info.bind(console),
    warn: console.warn.bind(console), error: console.error.bind(console),
  };
  for (const level of ['log', 'error', 'warn', 'info']) {
    console[level] = (...args) => real[level](`[${ts()}]`, ...args);
  }

  try {
    const LOG_DIR = process.env.FEISHU_BRIDGE_LOG_DIR || path.join(os.homedir(), '.codes', 'logs');
    const MAX_BYTES = parseInt(process.env.FEISHU_BRIDGE_LOG_MAX_BYTES || String(20 * 1024 * 1024), 10);
    const MAX_FILES = parseInt(process.env.FEISHU_BRIDGE_LOG_MAX_FILES || '3', 10);
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const makeSink = (file) => {
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      const roll = () => {
        for (let i = MAX_FILES - 1; i >= 1; i--) {
          try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
        }
        try { fs.renameSync(file, `${file}.1`); } catch {}
        size = 0;
      };
      // Roll a pre-existing oversized file before appending to it.
      if (size >= MAX_BYTES) roll();
      // Synchronous append: durable even on crash/process.exit (async
      // createWriteStream would lose buffered lines on a fast exit). The
      // bridge isn't log-chatty, so the sync cost is negligible.
      return (str) => {
        try {
          fs.appendFileSync(file, str);
          size += Buffer.byteLength(str);
          if (size >= MAX_BYTES) roll();
        } catch {
          // best effort — logging must never crash the bridge
        }
      };
    };

    const sinkOut = makeSink(path.join(LOG_DIR, 'feishu-bridge.out.log'));
    const sinkErr = makeSink(path.join(LOG_DIR, 'feishu-bridge.err.log'));
    console.log = (...args) => sinkOut(`[${ts()}] ${util.format(...args)}\n`);
    console.info = (...args) => sinkOut(`[${ts()}] ${util.format(...args)}\n`);
    console.warn = (...args) => sinkErr(`[${ts()}] ${util.format(...args)}\n`);
    console.error = (...args) => sinkErr(`[${ts()}] ${util.format(...args)}\n`);
  } catch (e) {
    real.error('[log] rotating-file setup failed, falling back to journal:', e?.message || String(e));
  }
}

// Load .env automatically (so users don't need to export env vars manually).
// - Does NOT override existing process.env values.
// - Keeps this bridge dependency-free (no dotenv package).
loadDotEnvIfPresent();

function loadDotEnvIfPresent() {
  const candidates = [
    // cwd
    path.resolve(process.cwd(), '.env'),
    // script dir
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env'),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const i = s.indexOf('=');
        if (i <= 0) continue;
        const k = s.slice(0, i).trim();
        const v = s.slice(i + 1).trim();
        if (!k) continue;
        if (process.env[k] == null) process.env[k] = v;
      }
      return;
    } catch {
      // ignore
    }
  }
}

// ─── Config ──────────────────────────────────────────────────────

// Local markdown media support (issue #3): allow reading ONLY under these dirs.
// Default supports the common local automation path: ~/.codes/media
const ALLOWED_LOCAL_MEDIA_DIRS = (process.env.FEISHU_BRIDGE_ALLOWED_LOCAL_MEDIA_DIRS || '~/.codes/media')
  .split(',')
  .map((s) => resolvePath(s.trim()))
  .filter(Boolean);

// Outbound media (agent → Feishu): allow sending files ONLY from these dirs.
// Default includes /tmp so tool-generated images can be sent.
const ALLOWED_OUTBOUND_MEDIA_DIRS = (
  process.env.FEISHU_BRIDGE_ALLOWED_OUTBOUND_MEDIA_DIRS || `~/.codes/media,${os.tmpdir()},/tmp`
)
  .split(',')
  .map((s) => resolvePath(s.trim()))
  .filter(Boolean);

const MAX_LOCAL_FILE_MB = Number(process.env.FEISHU_BRIDGE_MAX_LOCAL_FILE_MB ?? 15);
const MAX_INBOUND_IMAGE_MB = Number(process.env.FEISHU_BRIDGE_MAX_INBOUND_IMAGE_MB ?? 12);
const MAX_INBOUND_FILE_MB = Number(process.env.FEISHU_BRIDGE_MAX_INBOUND_FILE_MB ?? 40);
const INBOUND_FILE_TTL_MIN = Number(process.env.FEISHU_BRIDGE_INBOUND_FILE_TTL_MIN ?? 60);
const MAX_ATTACHMENTS = Number(process.env.FEISHU_BRIDGE_MAX_ATTACHMENTS ?? 4);

const SELFTEST = process.argv.includes('--selftest') || process.env.FEISHU_BRIDGE_SELFTEST === '1';
let DEBUG = process.env.FEISHU_BRIDGE_DEBUG === '1';
const BRIDGE_VERSION = readBridgeVersion();
// Protocol-tested codex CLI version. app-server protocol churns fast
// (stable releases every 2-4 days); a mismatch is a warning, not fatal.
const EXPECTED_CODEX_VERSION = '0.169.0';

// ─── Helpers ─────────────────────────────────────────────────────

function resolvePath(p) {
  return String(p || '').replace(/^~/, os.homedir());
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}分${rem}秒` : `${m}分钟`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDateTime(d) {
  const date = new Date(d);
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

function computeDelayScheduleTime(hours, minutes, now = new Date()) {
  const base = new Date(now.getTime());
  const delayMs = (Math.max(0, hours) * 60 + Math.max(0, minutes)) * 60 * 1000;
  return new Date(base.getTime() + delayMs);
}

/**
 * Parse one-off delayed send command:
 *   /xx-dd message...  => xx hours later + dd minutes later
 * Returns:
 *   null                                      -> not a delayed-send command
 *   { error: string }                         -> command format but invalid
 *   { hours: number, minutes: number, text: string } -> valid delayed-send command
 */
function parseDelayedSendCommand(rawText) {
  const raw = String(rawText ?? '').trim();
  const m = raw.match(/^\/(\d{1,5})-(\d{1,2})(?:\s+([\s\S]*))?$/);
  if (!m) return null;

  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const text = String(m[3] || '').trim();

  if (!Number.isInteger(hours) || hours < 0 || hours > 999) {
    return { error: '小时必须在 0-999 之间。' };
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return { error: '分钟必须在 00-59 之间。' };
  }
  if (hours === 0 && minutes === 0) {
    return { error: '延迟时间不能为 0。示例: /0-10 十分钟后提醒我' };
  }
  if (!text) {
    return { error: '定时消息内容不能为空。示例: /2-30 两小时三十分钟后提醒我' };
  }
  return { hours, minutes, text };
}

function isLegacyClockScheduleCommand(rawText) {
  return /^\/\d{1,2}:\d{2}\b/.test(String(rawText ?? '').trim());
}

function readBridgeVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg?.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function mustRead(filePath, label) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`[FATAL] ${label} not found: ${resolved}`);
    process.exit(1);
  }
  const val = fs.readFileSync(resolved, 'utf8').trim();
  if (!val) {
    console.error(`[FATAL] ${label} is empty: ${resolved}`);
    process.exit(1);
  }
  return val;
}

const uuid = () => crypto.randomUUID();

function toNodeReadableStream(maybeStream) {
  if (!maybeStream) return null;
  if (typeof maybeStream.pipe === 'function') return maybeStream; // Node stream
  // Web stream
  if (typeof maybeStream.getReader === 'function' && typeof Readable.fromWeb === 'function') {
    return Readable.fromWeb(maybeStream);
  }
  return null;
}

function truncate(s, max = 2000) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, max) + `…(truncated, ${str.length} chars)`;
}

function decodeHtmlEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Normalize Feishu "text" payloads.
 * Some clients may send HTML-ish strings like <p>- 1</p><p>- 2</p>.
 */
function normalizeFeishuText(raw) {
  let t = String(raw ?? '');

  // Convert common HTML blocks to newlines
  t = t.replace(/<\s*br\s*\/?>/gi, '\n');
  t = t.replace(/<\s*\/p\s*>\s*<\s*p\s*>/gi, '\n');
  t = t.replace(/<\s*p\s*>/gi, '');
  t = t.replace(/<\s*\/p\s*>/gi, '');

  // Strip remaining tags
  t = t.replace(/<[^>]+>/g, '');

  t = decodeHtmlEntities(t);

  // Normalize newlines
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  // Fix Feishu list quirk: sometimes list marker and content are split into two lines.
  //   "-\n1" -> "- 1"
  //   "•\nfoo" -> "• foo"
  t = t.replace(/(^|\n)([-*•])\n(?=\S)/g, '$1$2 ');
  t = t.replace(/(^|\n)(\d+[\.|\)])\n(?=\S)/g, '$1$2 ');

  return t.trim();
}

function extLower(p) {
  return path.extname(p || '').toLowerCase().replace(/^\./, '');
}

function guessMimeByExt(p) {
  const e = extLower(p);
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'mp4') return 'video/mp4';
  if (e === 'mov') return 'video/quicktime';
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'wav') return 'audio/wav';
  if (e === 'm4a') return 'audio/mp4';
  if (e === 'opus') return 'audio/opus';
  return 'application/octet-stream';
}

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isAllowedLocalPath(filePath) {
  const p = path.resolve(filePath);
  return ALLOWED_LOCAL_MEDIA_DIRS.some((dir) => isPathInside(p, dir) || p === dir);
}

function isAllowedOutboundPath(filePath) {
  const p = path.resolve(filePath);
  return ALLOWED_OUTBOUND_MEDIA_DIRS.some((dir) => isPathInside(p, dir) || p === dir);
}

function scheduleCleanup(filePath, minutes = INBOUND_FILE_TTL_MIN) {
  const ms = Math.max(1, Number(minutes || 0)) * 60 * 1000;
  const t = setTimeout(() => {
    try { fs.unlinkSync(filePath); } catch {}
  }, ms);
  // Let Node exit even if the timer is pending.
  if (typeof t.unref === 'function') t.unref();
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function looksLikeMediaRef(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^data:[^;]+;base64,/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^file:\/\//i.test(v)) return true;
  if (v.startsWith('/') && /\.(png|jpe?g|gif|webp|bmp|mp4|mov|mp3|wav|m4a|opus)$/i.test(v)) return true;
  if (/^MEDIA:\s*\S+/i.test(v)) return true;
  return false;
}

function extractMediaRefsDeep(value, limit = 8) {
  const out = [];
  const seen = new Set();
  const walk = (x, depth) => {
    if (out.length >= limit) return;
    if (depth > 4) return;

    if (typeof x === 'string') {
      if (looksLikeMediaRef(x)) {
        const m = /^MEDIA:\s*(\S+)/i.exec(x.trim());
        const ref = m ? m[1] : x.trim();
        if (!seen.has(ref)) {
          seen.add(ref);
          out.push(ref);
        }
      }
      return;
    }

    if (!x) return;
    if (Array.isArray(x)) {
      for (const it of x) walk(it, depth + 1);
      return;
    }

    if (typeof x === 'object') {
      for (const v of Object.values(x)) walk(v, depth + 1);
    }
  };

  walk(value, 0);
  return out;
}

function safeFileSizeOk(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, reason: 'not a file' };
    const maxBytes = MAX_LOCAL_FILE_MB * 1024 * 1024;
    if (st.size > maxBytes) return { ok: false, reason: `too large (${st.size} bytes)` };
    return { ok: true, size: st.size };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

function fileToDataUrl(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  return `data:${mimeType};base64,${b64}`;
}

function isProbablyImagePath(p) {
  return /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(p);
}

function isProbablyVideoPath(p) {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(p);
}

function isProbablyAudioPath(p) {
  return /\.(opus|mp3|wav|m4a|aac|ogg)$/i.test(p);
}

function extractMarkdownLocalMediaPaths(text) {
  const t = String(text ?? '');
  const out = [];

  // Markdown image syntax: ![alt](path)
  // Note: we only care about absolute local paths or file:// URLs.
  const mdImageRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = mdImageRe.exec(t))) {
    const raw = (m[1] || '').trim().replace(/^</, '').replace(/>$/, '');
    if (!raw) continue;
    if (raw.startsWith('file://')) out.push(raw.replace('file://', ''));
    else if (raw.startsWith('/')) out.push(raw);
    else if (raw.startsWith('~')) out.push(resolvePath(raw));
  }

  // Also support bare local paths (rare): /Users/.../.codes/media/xxx.png or /tmp/xxx.png
  const barePathRe = /\/(Users|home|tmp)\/[^\s)]+\.(png|jpg|jpeg|gif|webp|bmp)/gi;
  while ((m = barePathRe.exec(t))) {
    out.push(m[0]);
  }

  // Dedup
  return [...new Set(out)];
}

function stripMarkdownLocalMediaRefs(text) {
  const t = String(text ?? '');
  // Remove markdown image refs and bare paths; keep text readable.
  return t
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '[图片]')
    .replace(/\/(Users|home)\/[^\s)]+\.(png|jpg|jpeg|gif|webp|bmp)/gi, '[图片]')
    .trim();
}

function parseMediaLines(replyText) {
  const text = String(replyText ?? '');
  const lines = text.split(/\r?\n/);
  const media = [];
  const kept = [];

  const pushMedia = (raw) => {
    let u = String(raw || '').trim();
    if (!u) return;
    // Strip angle brackets and trailing punctuation.
    u = u.replace(/^</, '').replace(/>$/, '').replace(/[),.;，。；]+$/, '').trim();
    if (!u) return;
    media.push(u);
  };

  for (const line of lines) {
    // 1) Dedicated MEDIA line
    const m = line.match(/^\s*MEDIA\s*[:：]\s*(.+?)\s*$/i);
    if (m) {
      pushMedia(m[1]);
      continue;
    }

    // 2) Inline MEDIA tokens (some agents print "... MEDIA: /path.png" in the same line)
    const inlineRe = /MEDIA\s*[:：]\s*(\S+)/gi;
    let mm;
    let foundInline = false;
    while ((mm = inlineRe.exec(line))) {
      foundInline = true;
      pushMedia(mm[1]);
    }
    if (foundInline) {
      // keep the line but remove the MEDIA token chunk to avoid clutter
      kept.push(line.replace(inlineRe, '').trim());
      continue;
    }

    kept.push(line);
  }

  return { text: kept.join('\n').trim(), mediaUrls: [...new Set(media)] };
}

async function downloadUrlToTempFile(url) {
  const u = String(url);
  const ext = extLower(u) || 'bin';
  const tmp = path.join(os.tmpdir(), `feishu_bridge_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`);

  const proto = u.startsWith('https') ? https : http;

  await new Promise((resolve, reject) => {
    const req = proto.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new Error('Redirect without location header'));
        downloadUrlToTempFile(loc).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(tmp);
      pipeline(res, out).then(resolve).catch(reject);
    });
    req.on('error', reject);
  });

  return tmp;
}

function cleanupTempFile(filePath) {
  try {
    if (filePath && filePath.startsWith(os.tmpdir())) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ─── CodexAppServer ─────────────────────────────────────────────
// Bridges one Codex CLI `app-server` subprocess (JSON-RPC 2.0 over stdio,
// newline-delimited JSON) to a Feishu project. One process per conversation.
//
// Wire protocol (validated against codex-cli 0.169.0):
//   → initialize + initialized          handshake, once per connection
//   → thread/start | thread/resume      open / continue a thread; the
//                                       thread id IS the persisted session
//   → turn/start                        send user text, starts a turn
//   ← item/agentMessage/delta           streamed answer text
//   ← item/started + item/completed     item lifecycle (tools, messages)
//   ← thread/tokenUsage/updated         token accounting (last + total)
//   ← turn/completed                    terminal: completed|interrupted|failed
//   ← item/*/requestApproval            server-initiated request — MUST reply
//   → turn/interrupt                    cancel an in-flight turn
//
// Inherit local Codex configuration unless an explicit thread override is set.
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_DEFAULT_SANDBOX = null;
const CODEX_DEFAULT_APPROVAL = null;
const CODEX_INIT_TIMEOUT_MS = 60_000;
const CODEX_RPC_TIMEOUT_MS = 30_000;
const CODEX_INTERRUPT_WATCHDOG_MS = 8_000;

class CodexAppServer {
  /**
   * @param {{
   *   workDir: string,
   *   codexPath?: string,
   *   threadId?: string | null,
   *   model?: string | null,
   *   reasoningEffort?: string | null,
   *   provider?: string | null,
   *   sandbox?: string,
   *   approvalPolicy?: string,
   *   contextWindow?: number | null,
   *   extraConfig?: Record<string, string | number | boolean | Array<string | number | boolean>> | null,
   * }} opts
   */
  constructor({
    workDir,
    codexPath = 'codex',
    threadId = null,
    model = null,
    reasoningEffort = null,
    provider = null,
    sandbox = CODEX_DEFAULT_SANDBOX,
    approvalPolicy = CODEX_DEFAULT_APPROVAL,
    contextWindow = null,
    extraConfig = null,
  }) {
    this._workDir = workDir;
    this._codexPath = codexPath;
    this._sessionId = threadId;   // codex thread id (rollout persisted by codex)
    this._model = model;          // null = config.toml default
    this._reasoningEffort = reasoningEffort; // null = config.toml default
    this._defaultModel = model;
    this._defaultReasoningEffort = reasoningEffort;
    this._provider = provider;    // null = config.toml default
    this._sandbox = sandbox;
    this._approvalPolicy = approvalPolicy;
    this._contextWindow = contextWindow; // null = config.toml default
    this._extraConfig = extraConfig || null; // raw codex config keys (snake_case), highest precedence

    this._process = null;
    this._initialized = false;    // initialize handshake done for this process
    this._threadReady = false;    // thread started/resumed in this process

    this._nextRpcId = 1;
    this._pending = new Map();    // rpcId → { resolve, reject, method, timer }
    this._pendingResolve = null;  // sendMessage promise pair
    this._pendingReject = null;

    this._costUsd = 0;            // accumulated total tokens across turns
    this._turnCount = 0;
    this._lastUsage = null;       // latest ThreadTokenUsage (for /context)
    this._lastTurnError = null;

    this._status = 'idle';        // idle | busy | stopped
    this._busySince = null;
    this._lastActivity = null;
    this._onStream = null;
    this._streamedText = '';
    this._hasAssistantText = false;
    this._lastAgentText = null;   // text of the last completed agentMessage item
    this._turnId = null;
    this._interrupted = false;
    this._interruptWatchdog = null;
    this._stdoutBuf = '';
    this._stderrTail = '';        // last stderr bytes, for crash diagnostics
    this._connLock = Promise.resolve(); // serializes connection-level ops
  }

  /**
   * Serialize connection-level operations (start / ensureThread / compact).
   * Without this, a compact racing a message can spawn duplicate app-server
   * processes or open two threads at once.
   */
  _withConnLock(fn) {
    const prev = this._connLock;
    let release;
    this._connLock = new Promise((r) => { release = r; });
    return prev.then(fn, fn).finally(() => release());
  }

  /**
   * Ensure the app-server process is up and initialized. Idempotent;
   * respawns after a crash (the next _ensureThread resumes the thread).
   * Callers from parallel entry points must hold _withConnLock.
   */
  async start() {
    if (this._status === 'stopped') throw new Error('CodexAppServer is stopped');
    if (this._process && this._process.exitCode === null) {
      if (this._initialized) return;
      // Alive but never finished the handshake (initialize timed out). Kill
      // it before respawning so we don't orphan a process holding CODEX_HOME.
      const stale = this._process;
      this._process = null;
      try { stale.kill('SIGKILL'); } catch {}
    }

    this._cleanupProcessState();

    const proc = spawn(this._codexPath, ['app-server'], {
      cwd: this._workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this._process = proc;

    // Decode stdout as UTF-8 across chunk boundaries (CJK answers would
    // garble when a multi-byte char splits across two chunks).
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdoutData(proc, chunk));
    proc.stderr.on('data', (chunk) => {
      if (proc !== this._process) return;
      const text = chunk.toString();
      // Keep a small tail for crash diagnostics; codex also emits its tracing
      // log here (bwrap warnings etc.), so don't treat it as fatal by itself.
      this._stderrTail = (this._stderrTail + text).slice(-4096);
      if (DEBUG) console.log(`[codex:stderr] ${text.trimEnd()}`);
    });
    proc.on('exit', (code, signal) => this._onProcessExit(proc, code, signal));
    proc.on('error', (err) => {
      console.error(`[ERROR] codex process error: ${err.message}`);
      this._onProcessExit(proc, -1, null);
    });
    // Writes racing process death surface EPIPE asynchronously here; the
    // exit handler already rejects everything, so just absorb the event —
    // an unhandled 'error' on the stream would crash the whole bridge.
    proc.stdin.on('error', () => {});

    if (DEBUG) console.log(`[codex] spawned pid=${proc.pid} cwd=${this._workDir} home=${CODEX_HOME}`);

    await this._initialize();
  }

  async _initialize() {
    const res = await this._send('initialize', {
      clientInfo: { name: 'feishu-codes-bridge', title: 'Feishu Codes Bridge', version: BRIDGE_VERSION },
      capabilities: {},
    }, CODEX_INIT_TIMEOUT_MS);
    this._notify('initialized');
    this._initialized = true;
    if (DEBUG) console.log(`[codex] initialized (codexHome=${res?.codexHome || '?'})`);
  }

  /**
   * Make sure a thread is open in the current process: resume the persisted
   * thread when we have an id, otherwise start a fresh one. Per-project
   * model/provider/sandbox overrides are (re)applied here so bridge.json
   * stays authoritative over the thread's persisted settings.
   */
  async _ensureThread() {
    if (this._threadReady && this._sessionId) return;

    const overrides = {
      ...(this._model ? { model: this._model } : {}),
      ...(this._provider ? { modelProvider: this._provider } : {}),
      ...(this._approvalPolicy ? { approvalPolicy: this._approvalPolicy } : {}),
      ...(this._sandbox ? { sandbox: this._sandbox } : {}),
      // Free-form config overrides (validated against codex 0.169.0): applied
      // per thread via the `config` object, which codex merges as top-level
      // config overrides (higher precedence than config.toml). The effective
      // usable context window is the configured value minus codex headroom (~95%).
      ...(() => {
        const config = {
          ...(this._contextWindow ? { model_context_window: this._contextWindow } : {}),
          ...(this._extraConfig || {}),
          ...(this._reasoningEffort ? { model_reasoning_effort: this._reasoningEffort } : {}),
        };
        return Object.keys(config).length ? { config } : {};
      })(),
    };

    if (this._sessionId) {
      try {
        await this._send('thread/resume', {
          threadId: this._sessionId,
          excludeTurns: true,
          ...overrides,
        }, CODEX_RPC_TIMEOUT_MS);
        this._threadReady = true;
        if (DEBUG) console.log(`[codex] resumed thread ${this._sessionId}`);
        return;
      } catch (err) {
        // Thread gone or unreadable (deleted, corrupted, held by another
        // process) — fall back to a fresh thread rather than failing the message.
        console.warn(`[codex] thread/resume failed (${err.message}); starting a fresh thread`);
        this._sessionId = null;
      }
    }

    const res = await this._send('thread/start', {
      cwd: this._workDir,
      ...overrides,
    }, CODEX_RPC_TIMEOUT_MS);
    this._sessionId = res.thread.id;
    this._threadReady = true;
    if (DEBUG) console.log(`[codex] started thread ${this._sessionId} cwd=${this._workDir}`);
  }

  /**
   * Send a message to the Codex agent and wait for the turn to complete.
   * @param {string} text
   * @param {{ onStream?: ((accumulated: string) => void) | null }} [opts]
   * @returns {Promise<{text: string, sessionId: string|null, costUsd: number, interrupted?: boolean}>}
   */
  async sendMessage(text, { onStream = null } = {}) {
    if (this._status === 'stopped') throw new Error('CodexAppServer is stopped');
    if (this._status === 'busy') throw new Error('Codex is already processing a message');

    // Claim busy SYNCHRONOUSLY before any await: otherwise two concurrent
    // messages can both pass the guard while start()/_ensureThread() is in
    // flight and open two turns at once.
    this._status = 'busy';
    this._busySince = Date.now();
    this._lastActivity = { type: 'thinking', tool: null, ts: Date.now() };
    this._onStream = onStream;
    this._streamedText = '';
    this._hasAssistantText = false;
    this._lastAgentText = null;
    this._interrupted = false;
    this._lastTurnError = null;

    let turn;
    try {
      // Under the conn lock so a racing /compact cannot spawn a second
      // process or open a thread concurrently.
      turn = await this._withConnLock(async () => {
        await this.start();           // spawn + initialize (respawn after crash)
        await this._ensureThread();   // thread/start or thread/resume

        const turnParams = {
          threadId: this._sessionId,
          input: [{ type: 'text', text }],
        };
        // Turn-level overrides re-pin the thread settings, so runtime
        // /model and /hard switches take effect on the next message.
        if (this._model) turnParams.model = this._model;
        if (this._reasoningEffort) turnParams.effort = this._reasoningEffort;

        const res = await this._send('turn/start', turnParams, CODEX_RPC_TIMEOUT_MS);
        return res.turn;
      });
    } catch (err) {
      this._status = 'idle';
      this._busySince = null;
      this._lastActivity = null;
      this._onStream = null;
      this._streamedText = '';
      this._turnId = null;   // never leave a stale turn id behind
      throw err;
    }
    this._turnId = turn.id;

    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;
    });
  }

  /** Trigger conversation-history compaction for the project's thread. */
  async compact() {
    if (this._status === 'busy') return { ok: false, error: '正在处理消息，无法压缩' };
    // Claim busy so a message cannot race the compaction setup, and run the
    // connection work under the same lock as sendMessage.
    this._status = 'busy';
    this._busySince = Date.now();
    this._lastActivity = { type: 'tool_use', tool: 'compact', ts: Date.now() };
    try {
      await this._withConnLock(async () => {
        await this.start();
        await this._ensureThread();
        await this._send('thread/compact/start', { threadId: this._sessionId }, CODEX_RPC_TIMEOUT_MS);
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      this._status = 'idle';
      this._busySince = null;
      this._lastActivity = null;
    }
  }

  /**
   * Steer the active turn with additional user input — the message is folded
   * into the in-flight turn instead of waiting for the next one. Returns
   * { ok: false } when no turn is active or the turn is not steerable
   * (e.g. compaction/review turns), so the caller can queue as before.
   */
  async steer(text) {
    if (this._status !== 'busy' || !this._turnId || !this._sessionId) {
      return { ok: false, error: 'no active turn' };
    }
    try {
      await this._send('turn/steer', {
        threadId: this._sessionId,
        input: [{ type: 'text', text }],
        expectedTurnId: this._turnId,
      }, CODEX_RPC_TIMEOUT_MS);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────

  /** Send a JSON-RPC request and wait for the matching response. */
  _send(method, params, timeoutMs = CODEX_RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this._process || this._process.exitCode !== null) {
        reject(new Error('codex app-server process is not running'));
        return;
      }
      // Prefixed string ids: codex's server-initiated requests use its own
      // integer counter; separate namespaces guarantee the two can never
      // collide in _dispatch.
      const id = `bridge-${this._nextRpcId++}`;
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`codex RPC timeout (${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        this._process.stdin.write(JSON.stringify({ method, id, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`failed to write to codex stdin: ${err.message}`));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  _notify(method, params = {}) {
    if (!this._process || this._process.exitCode !== null) return;
    try {
      this._process.stdin.write(JSON.stringify({ method, params }) + '\n');
    } catch {}
  }

  /** Answer a server-initiated request (approvals, elicitations…). */
  _replyToServerRequest(id, result) {
    if (!this._process || this._process.exitCode !== null) return;
    try {
      this._process.stdin.write(JSON.stringify({ id, result }) + '\n');
    } catch {}
  }

  _rejectAllPending(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      this._pending.delete(id);
      p.reject(err);
    }
  }

  _clearSendMessagePending() {
    this._pendingResolve = null;
    this._pendingReject = null;
  }

  // ── stdout dispatch ───────────────────────────────────────────

  _onStdoutData(proc, chunk) {
    if (proc !== this._process) return; // superseded process — ignore its tail
    this._stdoutBuf += chunk;

    // Guard against unbounded buffer growth (e.g. a giant tool output item)
    if (this._stdoutBuf.length > 64 * 1024 * 1024) {
      console.error('[ERROR] codex stdout buffer overflow (>64MB), killing process');
      this._stdoutBuf = '';
      if (this._process) try { this._process.kill('SIGKILL'); } catch {}
      return;
    }

    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop() || ''; // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        if (DEBUG) console.log(`[codex] non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 1) Response to one of our requests
    if (msg.id != null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`codex ${p.method} failed: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // 2) Server-initiated request (approvals, user input, elicitations)
    if (msg.method && msg.id != null) {
      this._handleServerRequest(msg);
      return;
    }

    // 3) Notification
    if (msg.method) {
      this._handleNotification(msg.method, msg.params || {});
    }
  }

  /**
   * Answer server-initiated requests. The bridge is non-interactive by
   * design; every request gets an immediate answer so a turn can never hang
   * waiting on us. With approvalPolicy=never + danger-full-access these
   * should not normally occur.
   */
  _handleServerRequest(msg) {
    const { id, method, params } = msg;
    console.warn(`[codex] server request: ${method} (auto-responding)`);
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        // Auto-accept = parity with the previous --dangerously-skip-permissions.
        this._replyToServerRequest(id, { decision: 'accept' });
        return;
      case 'item/permissions/requestApproval':
        // Grant the requested subset back, session-scoped.
        this._replyToServerRequest(id, { scope: 'session', permissions: params?.permissions || {} });
        return;
      case 'item/tool/requestUserInput':
        // No interactive user available — answer nothing and let the agent adapt.
        this._replyToServerRequest(id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        this._replyToServerRequest(id, { action: 'decline', content: null });
        return;
      case 'attestation/generate':
        this._replyToServerRequest(id, { token: null });
        return;
      default:
        console.warn(`[codex] unknown server request ${method} — replying with error`);
        try {
          this._process.stdin.write(JSON.stringify({
            id,
            error: { code: -32601, message: `bridge does not handle ${method}` },
          }) + '\n');
        } catch {}
    }
  }

  // ── notifications ─────────────────────────────────────────────

  _handleNotification(method, params) {
    switch (method) {
      case 'item/agentMessage/delta': {
        this._streamedText += params.delta || '';
        this._hasAssistantText = true;
        this._lastActivity = { type: 'text', tool: null, ts: Date.now() };
        if (this._onStream && this._streamedText) this._onStream(this._streamedText);
        break;
      }

      case 'item/started': {
        const item = params.item || {};
        if (item.type !== 'agentMessage') this._noteToolActivity(item);
        break;
      }

      case 'item/completed': {
        const item = params.item || {};
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
          // Authoritative text for this message item. The LAST agentMessage of
          // the turn is the conclusion; earlier ones are process narration
          // before tool calls (dropped on tool start, AtomCode _finalText parity).
          this._lastAgentText = item.text;
        }
        break;
      }

      case 'turn/plan/updated':
        this._lastActivity = { type: 'tool_use', tool: 'plan', ts: Date.now() };
        break;

      // Reasoning streams (open models emit raw text, OpenAI-style summaries).
      // They carry no user-visible content here — just mark the turn active.
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
        this._lastActivity = { type: 'thinking', tool: null, ts: Date.now() };
        break;

      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage;
        if (usage) {
          this._lastUsage = usage;
          const last = Number(usage.last?.totalTokens || 0);
          if (last > 0) this._costUsd += last;
        }
        break;
      }

      case 'turn/completed':
        this._finishTurn(params.turn || {});
        break;

      case 'error':
        // Mid-turn error notification; turn/completed(failed) carries the same
        // payload and is authoritative. Keep the message for the reject text.
        this._lastTurnError = params.error?.message || 'codex error';
        console.error(`[codex] turn error: ${this._lastTurnError}`);
        break;

      case 'configWarning':
        console.warn(`[codex] configWarning: ${params.summary || ''}`);
        break;
      case 'warning':
        if (DEBUG) console.log(`[codex] warning: ${params.message || ''}`);
        break;

      // Benign lifecycle noise
      case 'thread/started':
      case 'thread/status/changed':
      case 'turn/started':
      case 'serverRequest/resolved':
      case 'account/rateLimits/updated':
      case 'remoteControl/status/changed':
      case 'turn/diff/updated':
        break;

      default:
        if (DEBUG) console.log(`[codex] unhandled notification: ${method}`);
    }
  }

  _noteToolActivity(item) {
    const TOOL_LABELS = {
      commandExecution: 'shell',
      fileChange: 'edit',
      mcpToolCall: 'mcp',
      webSearch: 'web_search',
      collabToolCall: 'subagent',
      imageGeneration: 'image_gen',
      imageView: 'image',
    };
    const label = TOOL_LABELS[item.type];
    if (!label) return;
    // A tool starting means any prior agent text was process narration, not
    // the conclusion — drop it so the final card shows only the post-tool tail.
    this._lastAgentText = null;
    this._lastActivity = { type: 'tool_use', tool: label, ts: Date.now() };
  }

  /** Resolve/reject the pending sendMessage promise at turn end. */
  _finishTurn(turn) {
    if (this._status !== 'busy') return; // stale notification (e.g. compaction)
    // Not our turn (e.g. a /compact compaction turn finishing while a user
    // message is in flight) — must not settle the message's promise.
    if (turn.id && this._turnId && turn.id !== this._turnId) return;
    this._turnId = null;
    if (this._interruptWatchdog) {
      clearTimeout(this._interruptWatchdog);
      this._interruptWatchdog = null;
    }
    this._turnCount++;

    const status = turn.status || 'completed';
    const interrupted = this._interrupted || status === 'interrupted';

    this._status = 'idle';
    this._busySince = null;
    this._lastActivity = null;
    this._onStream = null;
    this._streamedText = '';
    this._hasAssistantText = false;
    this._interrupted = false;

    const finalText = this._lastAgentText || '';
    this._lastAgentText = null;

    if (status === 'failed' && !interrupted) {
      const errMsg = turn.error?.message || this._lastTurnError || 'codex turn failed';
      this._lastTurnError = null;
      if (this._pendingReject) {
        const reject = this._pendingReject;
        this._clearSendMessagePending();
        reject(new Error(errMsg));
      }
      return;
    }

    this._lastTurnError = null;
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._clearSendMessagePending();
      resolve({
        text: interrupted ? '' : finalText,
        sessionId: this._sessionId,
        costUsd: 0, // tokens accumulate in _costUsd; see /cost
        ...(interrupted ? { interrupted: true } : {}),
      });
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────

  _cleanupProcessState() {
    this._initialized = false;
    this._threadReady = false;
    this._stdoutBuf = '';
    this._stderrTail = '';
    this._turnId = null;
    this._rejectAllPending(new Error('codex app-server connection reset'));
  }

  _onProcessExit(proc, code, signal) {
    // Identity check: a superseded process (replaced in start(), killed in
    // stop()) may exit much later — its stale event must not clobber the
    // state of the live connection.
    if (proc !== this._process) return;
    if (DEBUG) console.log(`[codex] exited code=${code} signal=${signal}`);
    this._process = null;
    this._initialized = false;
    this._threadReady = false;
    this._onStream = null;
    this._streamedText = '';
    this._stdoutBuf = '';
    this._turnId = null;

    this._rejectAllPending(
      new Error(`codex app-server exited unexpectedly (code=${code}, signal=${signal})`),
    );

    if (this._status !== 'busy') {
      if (this._status !== 'stopped') this._status = 'idle';
      return;
    }

    if (this._interrupted && this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._clearSendMessagePending();
      this._status = 'idle';
      this._interrupted = false;
      resolve({ text: '', interrupted: true, sessionId: this._sessionId, costUsd: 0 });
    } else if (this._pendingReject) {
      const reject = this._pendingReject;
      this._clearSendMessagePending();
      this._status = 'idle';
      const tail = this._stderrTail.trim().split('\n').slice(-3).join(' | ');
      reject(new Error(
        `codex app-server exited unexpectedly (code=${code}, signal=${signal})` +
        (tail ? ` — ${tail}` : ''),
      ));
    } else {
      this._status = 'idle';
    }
  }

  /** Interrupt the in-flight turn. Returns true if a turn was in progress. */
  interrupt() {
    if (this._status !== 'busy' || !this._turnId) return false;
    this._interrupted = true;
    this._send('turn/interrupt', {
      threadId: this._sessionId,
      turnId: this._turnId,
    }, 5000).catch(() => {});
    // Watchdog: if turn/completed never arrives, unstick the turn ourselves.
    this._interruptWatchdog = setTimeout(() => {
      if (this._status === 'busy' && this._interrupted) {
        console.warn('[codex] turn/completed missing after interrupt; forcing completion');
        this._finishTurn({ status: 'interrupted' });
      }
    }, CODEX_INTERRUPT_WATCHDOG_MS);
    return true;
  }

  /** Stop the process and mark as stopped (won't accept new messages). */
  async stop() {
    this._status = 'stopped';
    this._onStream = null;
    this._streamedText = '';
    if (this._interruptWatchdog) {
      clearTimeout(this._interruptWatchdog);
      this._interruptWatchdog = null;
    }

    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._clearSendMessagePending();
      reject(new Error('CodexAppServer stopped'));
    }
    this._rejectAllPending(new Error('CodexAppServer stopped'));

    if (!this._process) return;
    const proc = this._process;
    this._process = null;
    this._initialized = false;
    this._threadReady = false;

    try { proc.kill('SIGTERM'); } catch {}
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      // Do NOT unref — SIGKILL is critical cleanup
      proc.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }

  /** Re-enable after stop (allow new messages). Thread id is kept. */
  restart() {
    this._status = 'idle';
    this._pendingResolve = null;
    this._pendingReject = null;
    this._interrupted = false;
    this._onStream = null;
    this._streamedText = '';
    this._initialized = false;
    this._threadReady = false;
  }

  info() {
    return {
      status: this._status,
      pid: this._process?.pid || null,
      sessionId: this._sessionId || null,
      costUsd: this._costUsd, // total tokens (not USD — provider-dependent pricing)
      turnCount: this._turnCount,
      model: this._model || null,
      reasoningEffort: this._reasoningEffort || null,
      provider: this._provider || null,
      contextWindow: this._contextWindow || null,
      backend: 'codex',
    };
  }

  progressText() {
    if (this._status !== 'busy' || !this._busySince) return null;
    const elapsed = formatElapsed(Date.now() - this._busySince);
    const act = this._lastActivity;
    if (act?.type === 'tool_use' && act.tool) {
      return `正在处理… ${elapsed} | 工具: ${act.tool}`;
    }
    return `正在思考… ${elapsed}`;
  }
}

// ─── Bridge Config ───────────────────────────────────────────────

function loadBridgeConfig() {
  const configPath = resolvePath('~/.codes/bridge.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[FATAL] Bridge config not found: ${configPath}`);
    console.error('Create ~/.codes/bridge.json with your project configuration.');
    console.error('See bridge/bridge.example.json for a template.');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`[FATAL] Failed to parse ${configPath}: ${e?.message || String(e)}`);
    process.exit(1);
  }

  const projects = raw.projects || {};
  if (Object.keys(projects).length === 0) {
    console.error('[FATAL] No projects defined in bridge.json');
    process.exit(1);
  }
  if (raw.disabledGroupChats != null && (!Array.isArray(raw.disabledGroupChats)
    || raw.disabledGroupChats.some((id) => typeof id !== 'string' || !id.trim()))) {
    console.error('[FATAL] disabledGroupChats must be an array of non-empty chat ID strings');
    process.exit(1);
  }

  // Validate each project
  for (const [alias, proj] of Object.entries(projects)) {
    if (!proj.path) {
      console.error(`[FATAL] Project "${alias}" missing "path" in bridge.json`);
      process.exit(1);
    }
    const resolvedPath = resolvePath(proj.path);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`[FATAL] Project "${alias}" path not found: ${resolvedPath}`);
      process.exit(1);
    }
    proj.path = resolvedPath;

    if (!proj.feishu?.appId) {
      console.error(`[FATAL] Project "${alias}" missing "feishu.appId" in bridge.json`);
      process.exit(1);
    }
    if (!proj.feishu?.appSecretPath) {
      console.error(`[FATAL] Project "${alias}" missing "feishu.appSecretPath" in bridge.json`);
      process.exit(1);
    }
    proj.feishu.appSecretPath = resolvePath(proj.feishu.appSecretPath);
    if (proj.feishu.allowGroupChats != null && typeof proj.feishu.allowGroupChats !== 'boolean') {
      console.error(`[FATAL] Project "${alias}" feishu.allowGroupChats must be a boolean`);
      process.exit(1);
    }

    // Per-project Codex overrides (all optional — defaults come from the
    // top-level `codexDefaults` / local Codex config.toml). Providers are
    // configured in the local Codex config.toml.
    const cx = proj.codex || {};
    proj.codex = {
      model: cx.model || null,
      reasoningEffort: cx.reasoningEffort || null,
      provider: cx.provider || null,
      sandbox: cx.sandbox || null,
      approvalPolicy: cx.approvalPolicy || null,
      contextWindow: cx.contextWindow != null ? Number(cx.contextWindow) : null,
      extraConfig: extractExtraCodexConfig(cx, `projects."${alias}".codex`),
    };
    if (proj.codex.contextWindow != null && !(proj.codex.contextWindow > 0)) {
      console.error(`[FATAL] Project "${alias}" codex.contextWindow must be a positive number`);
      process.exit(1);
    }
  }

  if (raw.providers || raw.mcpServers) {
    console.warn('[WARN] bridge.json providers/mcpServers are no longer managed; configure them in your local Codex config.toml.');
  }

  try {
    indexBotProjects(projects);
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  }

  const codexDefaults = {
    model: raw.codexDefaults?.model || null,
    reasoningEffort: raw.codexDefaults?.reasoningEffort || null,
    provider: raw.codexDefaults?.provider || null,
    sandbox: raw.codexDefaults?.sandbox || CODEX_DEFAULT_SANDBOX,
    approvalPolicy: raw.codexDefaults?.approvalPolicy || CODEX_DEFAULT_APPROVAL,
    contextWindow: raw.codexDefaults?.contextWindow ? Number(raw.codexDefaults.contextWindow) : null,
    extraConfig: extractExtraCodexConfig(raw.codexDefaults, 'codexDefaults'),
  };
  // Backups are manual and opt-in; there is no daily scheduler.
  const backup = raw.backup && typeof raw.backup === 'object'
    ? { dest: resolvePath(String(raw.backup.dest ?? '~/Backups')) }
    : null;

  return {
    projects,
    disabledGroupChats: raw.disabledGroupChats || [],
    thinkingThresholdMs: Number(
      raw.thinkingThresholdMs ?? process.env.FEISHU_THINKING_THRESHOLD_MS ?? 2500,
    ),
    codexPath: raw.codexPath || 'codex',
    codexDefaults,
    debug: raw.debug === true || DEBUG,
    backup,
  };
}

// ─── ProjectManager ──────────────────────────────────────────────

const SESSIONS_PATH = resolvePath('~/.codes/bridge-sessions.json');
const SCHEDULED_PATH = resolvePath('~/.codes/bridge-scheduled.json');

/** bridge.json codex keys with dedicated handling; everything else passes through verbatim. */
const KNOWN_CODEX_KEYS = new Set(['model', 'reasoningEffort', 'provider', 'sandbox', 'approvalPolicy', 'contextWindow']);
const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Extract unknown codex.* keys for verbatim passthrough. Keys must be TOML bare
 * keys; values must be scalars or arrays of scalars for thread/start config.
 */
function extractExtraCodexConfig(source, where) {
  const extra = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (KNOWN_CODEX_KEYS.has(key)) continue;
    if (!TOML_BARE_KEY_RE.test(key)) {
      console.error(`[FATAL] ${where} key "${key}" must match ${TOML_BARE_KEY_RE} (codex config keys are snake_case)`);
      process.exit(1);
    }
    const valid = ['string', 'number', 'boolean'].includes(typeof value)
      || (Array.isArray(value) && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v)));
    if (!valid) {
      console.error(`[FATAL] ${where} key "${key}" must be a string, number, boolean, or array of those`);
      process.exit(1);
    }
    extra[key] = value;
  }
  return extra;
}

class ProjectManager {
  constructor(config) {
    this._config = config;
    this._disabledGroupChats = new Set(config.disabledGroupChats || []);
    /** @type {Map<string, {agent: CodexAppServer, started: boolean, path: string, feishuAppId: string}>} */
    this._projects = new Map();
    this.groupMessages = new GroupMessageBuffer();
    this.notices = new BridgeNoticeRegistry();
  }

  _createProject(alias, projectAlias, saved = {}) {
    const proj = this._config.projects[projectAlias];
    const cx = proj.codex || {};
    const defaults = this._config.codexDefaults || {};
    const agent = new CodexAppServer({
      workDir: proj.path,
      codexPath: this._config.codexPath,
      threadId: saved.sessionId || null,
      model: cx.model || defaults.model,
      reasoningEffort: cx.reasoningEffort || defaults.reasoningEffort,
      provider: cx.provider || defaults.provider,
      sandbox: cx.sandbox || defaults.sandbox,
      approvalPolicy: cx.approvalPolicy || defaults.approvalPolicy,
      contextWindow: cx.contextWindow || defaults.contextWindow,
      extraConfig: { ...defaults.extraConfig, ...cx.extraConfig },
    });
    agent._costUsd = Number(saved.costUsd) || 0;
    agent._turnCount = Number(saved.turnCount) || 0;
    const instance = {
      agent, started: true, path: proj.path, feishuAppId: proj.feishu.appId,
      backend: 'codex', projectAlias,
      chatType: saved.chatType || null, chatId: saved.chatId || null,
      replyPending: false, generation: 0,
    };
    this._projects.set(alias, instance);
    return instance;
  }

  _isGroupDisabled(projectAlias, chatId) {
    return this._disabledGroupChats.has(chatId)
      || this._config.projects[projectAlias]?.feishu.allowGroupChats === false;
  }

  getConversation(projectAlias, chatType, chatId) {
    const config = this._config.projects[projectAlias];
    if (!config || !['group', 'p2p'].includes(chatType) || !chatId) return null;
    if (chatType === 'group' && this._isGroupDisabled(projectAlias, chatId)) return null;
    const base = this._projects.get(projectAlias);
    // Preserve the old alias/thread for the first private conversation.
    // Every group uses a separate instance of this same project's config.
    if (base && chatType === 'p2p' && (!base.chatId || base.chatId === chatId)) {
      const newlyBound = !base.chatId;
      base.chatType = chatType;
      base.chatId = chatId;
      if (newlyBound) this._saveSessions();
      return { alias: projectAlias, project: base };
    }
    const key = conversationKey(projectAlias, chatType, chatId);
    let project = this._projects.get(key);
    if (project && (project.projectAlias !== projectAlias || project.chatType !== chatType || project.chatId !== chatId)) {
      throw new Error(`Conversation key conflicts with a configured project: ${key}`);
    }
    if (!project) {
      project = this._createProject(key, projectAlias, { chatType, chatId });
      this._saveSessions();
    }
    return { alias: key, project };
  }

  resolveTarget(currentAlias, target) {
    const current = this.getProject(currentAlias);
    if (!current?.chatId || !this._config.projects?.[target]) return target;
    return this.getConversation(target, current.chatType, current.chatId)?.alias
      || conversationKey(target, current.chatType, current.chatId);
  }

  _restoreProjects(saved) {
    for (const alias of Object.keys(this._config.projects)) {
      const state = saved[alias];
      // The base alias remains the legacy private entry; groups always use
      // a key containing the project alias and their chat ID.
      const compatible = state && (!state.chatType || state.chatType === 'p2p');
      this._createProject(alias, alias, compatible ? state : undefined);
    }
    for (const [alias, state] of Object.entries(saved)) {
      if (this._projects.has(alias) || !this._config.projects[state.projectAlias]
        || !state.chatId || !['p2p', 'group'].includes(state.chatType)
        || alias !== conversationKey(state.projectAlias, state.chatType, state.chatId)) continue;
      if (state.chatType === 'group' && this._isGroupDisabled(state.projectAlias, state.chatId)) continue;
      this._createProject(alias, state.projectAlias, state);
    }
  }

  _clearDisabledGroupMessages() {
    for (const projectAlias of Object.keys(this._config.projects)) {
      const prefix = conversationKey(projectAlias, 'group', '');
      for (const key of this.groupMessages.messages.keys()) {
        if (key.startsWith(prefix) && this._isGroupDisabled(projectAlias, key.slice(prefix.length))) {
          this.groupMessages.clear(key);
        }
      }
    }
  }

  async init() {
    this._restoreProjects(this._loadSessions());
    this.notices = new BridgeNoticeRegistry(resolvePath('~/.codes/bridge-notices.json'));
    this.groupMessages = new GroupMessageBuffer(resolvePath('~/.codes/bridge-group-messages.json'));
    this.groupMessages.prune((record) => this.notices.has(record.messageId));
    this._clearDisabledGroupMessages();
    this._saveSessions();

    // Auto-save sessions every 60s
    this._saveInterval = setInterval(() => this._saveSessions(), 60_000);
    if (this._saveInterval.unref) this._saveInterval.unref();

    // Save on process exit, kill all subprocesses
    const saveAndExit = async () => {
      this._saveSessions();
      await this.stopAll();
      for (const ch of new Set(channelMap.values())) {
        try { await ch.disconnect(); } catch {}
      }
      process.exit(0);
    };
    process.on('SIGINT', () => saveAndExit());
    process.on('SIGTERM', () => saveAndExit());
  }

  getProject(alias) {
    return this._projects.get(alias) || null;
  }

  async startProject(alias) {
    const proj = this._projects.get(alias);
    if (!proj) return { ok: false, error: `未知项目: ${alias}` };
    if (proj.started) return { ok: true, message: `${alias} 已在运行中` };
    proj.agent._model = proj.agent._defaultModel;
    proj.agent._reasoningEffort = proj.agent._defaultReasoningEffort;
    proj.agent.restart();
    proj.started = true;
    return { ok: true, message: `${alias} 已启动` };
  }

  async stopProject(alias) {
    const proj = this._projects.get(alias);
    if (!proj) return { ok: false, error: `未知项目: ${alias}` };
    if (!proj.started) return { ok: true, message: `${alias} 已处于停止状态` };
    await proj.agent.stop();
    proj.started = false;
    const pending = pendingMessages.get(alias);
    if (pending?.groupRecords) this.groupMessages.restore(alias, pending.groupRecords);
    pendingMessages.delete(alias);
    this._saveSessions();
    return { ok: true, message: `${alias} 已停止` };
  }

  async resetProject(alias) {
    const proj = this._projects.get(alias);
    if (!proj) return { ok: false, error: `未知项目: ${alias}` };
    this.groupMessages.clear(alias);
    proj.generation = (proj.generation || 0) + 1;
    proj.started = false;
    pendingMessages.delete(alias);
    await proj.agent.stop();
    proj.agent._sessionId = null;
    proj.agent._threadReady = false;
    proj.agent._model = proj.agent._defaultModel;
    proj.agent._reasoningEffort = proj.agent._defaultReasoningEffort;
    proj.agent._costUsd = 0;
    proj.agent._turnCount = 0;
    proj.agent.restart();
    proj.started = true;
    this._saveSessions();
    return { ok: true, message: `${alias} 会话已重置，下次对话将开始新会话（${proj.agent._model || 'Codex 默认模型'} + ${proj.agent._reasoningEffort || '默认推理强度'}）` };
  }

  async startAll() {
    const results = [];
    for (const alias of this._projects.keys()) {
      results.push({ alias, ...(await this.startProject(alias)) });
    }
    return results;
  }

  async stopAll() {
    const results = [];
    for (const alias of this._projects.keys()) {
      results.push({ alias, ...(await this.stopProject(alias)) });
    }
    return results;
  }

  status() {
    const out = {};
    for (const [alias, proj] of this._projects) {
      const info = proj.agent.info();
      out[alias] = { started: proj.started, path: proj.path, chatType: proj.chatType, chatId: proj.chatId, ...info };
    }
    return out;
  }

  aliases() {
    return [...this._projects.keys()];
  }

  _loadSessions() {
    try {
      if (fs.existsSync(SESSIONS_PATH)) {
        return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      }
    } catch {}
    return {};
  }

  async _runBackup(dest) {
    const home = os.homedir();
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (e) {
      console.error(`[BACKUP] 无法创建目标目录 ${dest}: ${e?.message || String(e)}`);
      return { ok: false, error: String(e?.message || e) };
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '_')
      .slice(0, 15);
    const outFile = path.join(dest, `backup_${timestamp}.tar.gz`);

    // Manual backup covers bridge data and any retained legacy home in ~/.codes.
    // The local Codex home (~/.codex) is independent and is not included.
    const targets = [];
    if (fs.existsSync(path.join(home, '.codes'))) targets.push('.codes');

    if (targets.length === 0) {
      console.warn('[BACKUP] 无可备份内容，已跳过');
      return { ok: false, error: '无可备份内容' };
    }

    console.log(`[BACKUP] 开始备份 → ${outFile}`);

    return new Promise((resolve) => {
      const args = [
        '-C', home,
        '--exclude=.codes/logs',
        '--exclude=.codes/logs/*',
        '--exclude=.codes/bridge-sessions.json',
        // Plugin marketplace sync cache (~98MB git clone) — re-downloaded on demand.
        '--exclude=.codes/codex-home/.tmp',
        '--exclude=.codes/codex-home/.tmp/*',
        // Transient runtime state.
        '--exclude=.codes/codex-home/tmp',
        '--exclude=.codes/codex-home/tmp/*',
        '--exclude=.codes/codex-home/shell_snapshots',
        '--exclude=.codes/codex-home/shell_snapshots/*',
        '--exclude=.codes/codex-home/thread-writer-locks',
        '--exclude=.codes/codex-home/thread-writer-locks/*',
        // Codex internal log DB (diagnostics only).
        '--exclude=.codes/codex-home/logs_2.sqlite',
        '--exclude=.codes/codex-home/logs_2.sqlite-wal',
        '--exclude=.codes/codex-home/logs_2.sqlite-shm',
        // Live SQLite sidecars: unsafe to tar while codex is running;
        // main .sqlite files keep the last checkpointed state.
        '--exclude=.codes/codex-home/*.sqlite-wal',
        '--exclude=.codes/codex-home/*.sqlite-shm',
        '-czf', outFile,
        ...targets,
      ];

      const proc = spawn('tar', args);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const stat = fs.statSync(outFile);
            const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
            console.log(`[BACKUP] 完成: ${outFile} (${sizeMb} MB)`);
            resolve({ ok: true, file: outFile, sizeBytes: stat.size });
          } catch (e) {
            resolve({ ok: true, file: outFile });
          }
        } else {
          console.error(`[BACKUP] 失败 (exit ${code}): ${stderr.trim()}`);
          try { fs.unlinkSync(outFile); } catch {}
          resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
        }
      });
      proc.on('error', (e) => {
        console.error(`[BACKUP] 无法启动 tar: ${e.message}`);
        resolve({ ok: false, error: e.message });
      });
    });
  }

  _saveSessions() {
    const data = {};
    for (const [alias, proj] of this._projects) {
      const info = proj.agent.info();
      data[alias] = {
        sessionId: info.sessionId,
        costUsd: info.costUsd,
        turnCount: info.turnCount,
        projectAlias: proj.projectAlias,
        chatType: proj.chatType,
        chatId: proj.chatId,
      };
    }
    try {
      fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });
      const tmp = SESSIONS_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, SESSIONS_PATH);
    } catch (e) {
      console.error(`[WARN] Failed to save sessions: ${e?.message || String(e)}`);
    }
  }
}

// ─── Dedup (Feishu may deliver the same event more than once) ────

const seenMap = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, ts] of seenMap) {
    if (now - ts > SEEN_TTL_MS) seenMap.delete(k);
  }
  if (!key) return false;
  if (seenMap.has(key)) return true;
  seenMap.set(key, now);
  return false;
}

// ─── Feishu message parsing ─────────────────────────────────────

function extractFromPostJson(postJson) {
  const lines = [];
  const imageKeys = [];

  const pushLine = (s) => {
    const v = String(s ?? '').trimEnd();
    if (v.trim()) lines.push(v);
  };

  const inline = (node) => {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(inline).join('');
    if (typeof node !== 'object') return '';

    const tag = node.tag;
    if (typeof tag === 'string') {
      if (tag === 'text') return String(node.text ?? '');
      if (tag === 'a') return String(node.text ?? node.href ?? '');
      if (tag === 'at') return node.user_name ? `@${node.user_name}` : '@';
      if (tag === 'md') return String(node.text ?? '');
      if (tag === 'img') {
        if (node.image_key) imageKeys.push(String(node.image_key));
        return '[图片]';
      }
      if (tag === 'file') return '[文件]';
      if (tag === 'media') return '[视频]';
      if (tag === 'hr') return '\n';
      if (tag === 'code_block') {
        const lang = String(node.language || '').trim();
        const code = String(node.text || '');
        return `\n\n\`\`\`${lang ? ` ${lang}` : ''}\n${code}\n\`\`\`\n\n`;
      }
    }

    // Fallback: traverse children to avoid dropping content when Feishu changes structure.
    let acc = '';
    for (const v of Object.values(node)) {
      if (v && (typeof v === 'object' || Array.isArray(v))) acc += inline(v);
    }
    return acc;
  };

  if (postJson?.title) pushLine(normalizeFeishuText(postJson.title));

  const content = postJson?.content;
  if (Array.isArray(content)) {
    for (const paragraph of content) {
      // In Feishu post, each paragraph is usually an array of inline nodes.
      if (Array.isArray(paragraph)) {
        const joined = paragraph.map(inline).join('');
        const normalized = normalizeFeishuText(joined);
        if (normalized) pushLine(normalized);
      } else {
        const normalized = normalizeFeishuText(inline(paragraph));
        if (normalized) pushLine(normalized);
      }
    }
  } else if (content) {
    const normalized = normalizeFeishuText(inline(content));
    if (normalized) pushLine(normalized);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { text, imageKeys: [...new Set(imageKeys)] };
}

async function downloadFeishuImageAsDataUrl(client, messageId, imageKey) {
  const tmp = path.join(os.tmpdir(), `feishu_recv_${Date.now()}_${Math.random().toString(16).slice(2)}.png`);
  try {
    if (DEBUG) console.log(`[DEBUG] Downloading image: messageId=${messageId}, imageKey=${imageKey}`);
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });

    // Debug: log response structure
    const responseType = typeof response;
    const responseKeys = response && typeof response === 'object' ? Object.keys(response) : [];
    if (DEBUG) console.log(`[DEBUG] Image response: type=${responseType}, keys=${responseKeys.join(',')}`);
    if (response && response.data) {
      const dataType = typeof response.data;
      const dataKeys = response.data && typeof response.data === 'object' ? Object.keys(response.data) : [];
      if (DEBUG) console.log(`[DEBUG] response.data: type=${dataType}, keys=${dataKeys.join(',')}`);
    }

    // SDK may return stream/buffer or wrap it inside { data: ... }
    const data = response;
    const payload = (data && typeof data === 'object' && 'data' in data) ? data.data : data;

    // Newer SDK versions return a "response-like" object with helpers.
    if (payload && typeof payload.writeFile === 'function') {
      await payload.writeFile(tmp);
    } else if (payload && typeof payload.getReadableStream === 'function') {
      const rs = payload.getReadableStream();
      const nodeRs = toNodeReadableStream(rs);
      if (!nodeRs) throw new Error('getReadableStream() returned non-stream');
      const out = fs.createWriteStream(tmp);
      await pipeline(nodeRs, out);
    } else if (payload && typeof payload.pipe === 'function') {
      const out = fs.createWriteStream(tmp);
      await pipeline(payload, out);
    } else if (data && data.data && typeof data.data === 'object' && typeof data.data.pipe === 'function') {
      // Some SDK versions nest the stream deeper
      const out = fs.createWriteStream(tmp);
      await pipeline(data.data, out);
    } else if (Buffer.isBuffer(payload)) {
      fs.writeFileSync(tmp, payload);
    } else if (payload instanceof ArrayBuffer) {
      fs.writeFileSync(tmp, Buffer.from(payload));
    } else if (ArrayBuffer.isView(payload)) {
      fs.writeFileSync(tmp, Buffer.from(payload.buffer));
    } else {
      const k = data && typeof data === 'object' ? Object.keys(data).join(',') : '';
      throw new Error(`Unexpected response type: ${typeof data}${k ? ` (keys: ${k})` : ''}`);
    }

    // Size guard: base64 data URLs explode in size; avoid large payloads.
    const st = fs.statSync(tmp);
    if (DEBUG) console.log(`[DEBUG] Image downloaded: ${st.size} bytes -> ${tmp}`);
    const maxBytes = MAX_INBOUND_IMAGE_MB * 1024 * 1024;
    if (st.size > maxBytes) {
      throw new Error(`Image too large (${st.size} bytes > ${maxBytes})`);
    }

    return fileToDataUrl(tmp, 'image/png');
  } finally {
    cleanupTempFile(tmp);
  }
}

async function downloadFeishuFileToPath(client, messageId, fileKey, fileName = 'file.bin', type = 'file') {
  const ext = path.extname(fileName || '') || '.bin';
  const tmp = path.join(
    os.tmpdir(),
    `feishu_recv_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
  );

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  const data = response;
  const payload = (data && typeof data === 'object' && 'data' in data) ? data.data : data;

  if (payload && typeof payload.writeFile === 'function') {
    await payload.writeFile(tmp);
  } else if (payload && typeof payload.getReadableStream === 'function') {
    const rs = payload.getReadableStream();
    const nodeRs = toNodeReadableStream(rs);
    if (!nodeRs) throw new Error('getReadableStream() returned non-stream');
    const out = fs.createWriteStream(tmp);
    await pipeline(nodeRs, out);
  } else if (payload && typeof payload.pipe === 'function') {
    const out = fs.createWriteStream(tmp);
    await pipeline(payload, out);
  } else if (data && data.data && typeof data.data === 'object' && typeof data.data.pipe === 'function') {
    const out = fs.createWriteStream(tmp);
    await pipeline(data.data, out);
  } else if (Buffer.isBuffer(payload)) {
    fs.writeFileSync(tmp, payload);
  } else if (payload instanceof ArrayBuffer) {
    fs.writeFileSync(tmp, Buffer.from(payload));
  } else if (ArrayBuffer.isView(payload)) {
    fs.writeFileSync(tmp, Buffer.from(payload.buffer));
  } else {
    const k = data && typeof data === 'object' ? Object.keys(data).join(',') : '';
    throw new Error(`Unexpected file response type: ${typeof data}${k ? ` (keys: ${k})` : ''}`);
  }

  // Size guard
  const st = fs.statSync(tmp);
  const maxBytes = MAX_INBOUND_FILE_MB * 1024 * 1024;
  if (st.size > maxBytes) {
    // Keep the file from accumulating.
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`File too large (${st.size} bytes > ${maxBytes})`);
  }

  // Keep the downloaded file alive long enough for the agent to use it.
  scheduleCleanup(tmp, INBOUND_FILE_TTL_MIN);

  return tmp;
}

// DEPRECATED: kept for fallback
async function buildInboundFromFeishuMessage(client, message) {
  const messageId = message?.message_id;
  const messageType = message?.message_type;
  const rawContent = message?.content;

  const out = {
    text: '',
    attachments: [],
    fallback: '',
  };

  out.fallback = `【Feishu消息】id=${messageId || '-'} type=${messageType}\ncontent=${truncate(rawContent, 1200)}`;

  if (!messageType || !rawContent) return out;

  // 1) text
  if (messageType === 'text') {
    try {
      const parsed = JSON.parse(rawContent);
      out.text = normalizeFeishuText(parsed?.text ?? '');
    } catch {
      out.text = '';
    }
  }

  // 2) post (rich text)
  if (messageType === 'post') {
    try {
      const parsed = JSON.parse(rawContent);
      const { text, imageKeys } = extractFromPostJson(parsed);
      out.text = text;

      // Download embedded images (best-effort)
      if (messageId && imageKeys.length > 0) {
        for (const k of imageKeys.slice(0, MAX_ATTACHMENTS)) {
          try {
            const dataUrl = await downloadFeishuImageAsDataUrl(client, messageId, k);
            out.attachments.push({ type: 'image', content: dataUrl, mimeType: 'image/png', fileName: 'feishu.png' });
          } catch (e) {
            // keep going
            console.error(`[WARN] post image download failed: messageId=${messageId} imageKey=${k} err=${e?.message || String(e)}`);
          }
        }
      }
    } catch (e) {
      out.text = '';
      console.error(`[WARN] post parse failed: ${e?.message || String(e)}`);
    }
  }

  // 3) image
  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(rawContent);
      const imageKey = parsed?.image_key;
      if (imageKey && messageId) {
        const dataUrl = await downloadFeishuImageAsDataUrl(client, messageId, imageKey);
        out.attachments.push({ type: 'image', content: dataUrl, mimeType: 'image/png', fileName: 'feishu.png' });
        out.text = '[图片]';
      }
    } catch (e) {
      // Don't drop the message; keep a minimal placeholder.
      out.text = '[图片]';
      console.error(`[WARN] image parse/download failed: messageId=${messageId} err=${e?.message || String(e)}`);
    }
  }

  // 4) media (video)
  if (messageType === 'media') {
    try {
      const parsed = JSON.parse(rawContent);
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || 'video.bin';
      const duration = parsed?.duration;
      const thumbKey = parsed?.image_key;

      out.text = `[视频] ${fileName}${duration ? ` (${duration}ms)` : ''}`;

      // Best-effort: thumbnail
      if (thumbKey && messageId) {
        try {
          const thumbUrl = await downloadFeishuImageAsDataUrl(client, messageId, thumbKey);
          out.attachments.push({ type: 'image', content: thumbUrl, mimeType: 'image/png', fileName: 'feishu-thumb.png' });
        } catch (e) {
          console.error(`[WARN] media thumbnail download failed: messageId=${messageId} imageKey=${thumbKey} err=${e?.message || String(e)}`);
        }
      }

      // Best-effort: download the video file so the agent can access it.
      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(client, messageId, fileKey, fileName, 'file');
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          console.error(`[WARN] media download failed: messageId=${messageId} fileKey=${fileKey} err=${e?.message || String(e)}`);
        }
      }
    } catch (e) {
      out.text = out.text || '[视频]';
      console.error(`[WARN] media parse failed: ${e?.message || String(e)}`);
    }
  }

  // 5) file
  if (messageType === 'file') {
    try {
      const parsed = JSON.parse(rawContent);
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || 'file.bin';
      out.text = `[文件] ${fileName}`;

      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(client, messageId, fileKey, fileName, 'file');
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          console.error(`[WARN] file download failed: messageId=${messageId} fileKey=${fileKey} err=${e?.message || String(e)}`);
        }
      }
    } catch (e) {
      out.text = out.text || '[文件]';
      console.error(`[WARN] file parse failed: ${e?.message || String(e)}`);
    }
  }

  // 6) audio
  if (messageType === 'audio') {
    try {
      const parsed = JSON.parse(rawContent);
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || 'audio.opus';
      out.text = `[语音] ${fileName}`;

      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(client, messageId, fileKey, fileName, 'file');
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          console.error(`[WARN] audio download failed: messageId=${messageId} fileKey=${fileKey} err=${e?.message || String(e)}`);
        }
      }
    } catch (e) {
      out.text = out.text || '[语音]';
      console.error(`[WARN] audio parse failed: ${e?.message || String(e)}`);
    }
  }

  // Local markdown images (issue #3): if text includes local paths, attach them.
  if (out.text) {
    const localPaths = extractMarkdownLocalMediaPaths(out.text).slice(0, MAX_ATTACHMENTS - out.attachments.length);
    for (const p of localPaths) {
      try {
        const fp = path.resolve(p);
        if (!isAllowedLocalPath(fp)) continue;
        const ok = safeFileSizeOk(fp);
        if (!ok.ok) continue;
        if (!isProbablyImagePath(fp)) continue;
        const mime = guessMimeByExt(fp);
        const dataUrl = fileToDataUrl(fp, mime);
        out.attachments.push({ type: 'image', content: dataUrl, mimeType: mime, fileName: path.basename(fp) });
      } catch (e) {
        console.error(`[WARN] local image attach failed: ${e?.message || String(e)}`);
      }
    }
    out.text = stripMarkdownLocalMediaRefs(out.text);
  }

  // Ensure we never silently drop: if still empty, use fallback.
  if (!out.text && out.attachments.length > 0) out.text = '[附件]';
  if (!out.text) out.text = out.fallback;

  // Hard cap
  if (out.attachments.length > MAX_ATTACHMENTS) out.attachments = out.attachments.slice(0, MAX_ATTACHMENTS);

  return out;
}

// ─── Feishu sending (text + media) ──────────────────────────────

async function sendText(channel, chatId, text, notice = false) {
  const send = async () => {
    try {
      return await channel.send(chatId, { text });
    } catch {
      // Fallback to raw API if channel.send fails
      return channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      });
    }
  };
  if (!notice || !channel.bridgeNotices) return send();
  // Register the exact text chunks too: SDK sends long plain text separately,
  // and their events may arrive before it returns the complete chunkIds list.
  const limit = channel.sender?.chunkLimit || 3500;
  const texts = [text];
  for (let start = 0; start < text.length; start += limit) texts.push(text.slice(start, start + limit));
  return channel.bridgeNotices.send(chatId, texts, send);
}

/**
 * Build a Feishu interactive card (schema 2.0) with markdown content.
 * Cards render code blocks, tables, and rich formatting properly in Feishu.
 */
function buildMarkdownCard(text, { showStopButton = false, streaming = false, summary = '' } = {}) {
  const elements = [{ tag: 'markdown', content: text }];
  if (showStopButton) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '⏹ 终止' },
        type: 'danger',
        value: { action: 'interrupt' },
      }],
    });
  }
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      ...(streaming ? { streaming_mode: true } : {}),
      ...(summary ? { summary: { content: summary } } : {}),
    },
    body: { elements },
  };
}

/**
 * Detect whether text contains markdown features that benefit from card rendering.
 * Returns true if text has fenced code blocks, tables, headings, bold/italic, or lists.
 */
function shouldUseMarkdownCard(text) {
  return (
    /```[\s\S]*?```/.test(text) ||          // fenced code block
    /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text) || // markdown table
    /\*\*\S/.test(text) ||                  // **bold**
    /^#{1,6} /m.test(text) ||              // # heading
    /^[-*] \S/m.test(text) ||              // - bullet list
    /^\d+\. \S/m.test(text)               // 1. ordered list
  );
}

/**
 * Send text as an interactive markdown card (interactive message type).
 * This renders code blocks, tables, bold/italic etc. properly in Feishu.
 */
async function sendMarkdownCard(channel, chatId, text, replyToMessageId, notice = false) {
  const card = buildMarkdownCard(text);
  const opts = replyToMessageId ? { replyTo: replyToMessageId } : {};

  const send = async () => {
    try {
      return await channel.send(chatId, { card }, opts);
    } catch {
      // Fallback to raw API if channel.send fails
      const content = JSON.stringify(card);
      if (replyToMessageId) {
        try {
          const res = await channel.rawClient.im.v1.message.reply({
            path: { message_id: replyToMessageId },
            data: { content, msg_type: 'interactive' },
          });
          if (res?.code === 0 || res?.code === undefined) return res;
        } catch {}
      }
      return channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
    }
  };
  return notice && channel.bridgeNotices ? channel.bridgeNotices.send(chatId, text, send) : send();
}


/**
 * Add an emoji reaction to a message (used as "typing" indicator).
 * Returns reactionId on success, or null on failure.
 */
async function addReaction(client, messageId, emojiType) {
  try {
    const res = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    return res?.data?.reaction_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove an emoji reaction from a message.
 */
async function removeReaction(client, messageId, reactionId) {
  try {
    await client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // Ignore — reaction may have already been removed
  }
}

async function uploadAndSendMedia(client, chatId, mediaUrlOrPath, captionText) {
  let tempPath = null;
  let localPath = null;

  try {
    const raw = String(mediaUrlOrPath || '').trim();
    if (!raw) return;

    if (raw.startsWith('file://')) {
      localPath = raw.replace('file://', '');
    } else if (raw.startsWith('~')) {
      localPath = resolvePath(raw);
    } else if (raw.startsWith('/')) {
      localPath = raw;
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      tempPath = await downloadUrlToTempFile(raw);
      localPath = tempPath;
    } else if (raw.startsWith('data:')) {
      // data:<mime>;base64,<payload>
      const m = raw.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) {
        await sendText(client, chatId, captionText ? `${captionText}\n${raw}` : raw);
        return;
      }
      const mime = m[1];
      const b64 = m[2];
      const ext = mime.includes('png')
        ? 'png'
        : mime.includes('jpeg') || mime.includes('jpg')
          ? 'jpg'
          : mime.includes('webp')
            ? 'webp'
            : 'bin';
      tempPath = path.join(os.tmpdir(), `feishu_out_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(b64, 'base64'));
      localPath = tempPath;
    } else {
      // Unknown scheme; just send as text.
      await sendText(client, chatId, captionText ? `${captionText}\n${raw}` : raw);
      return;
    }

    const p = path.resolve(localPath);
    const mime = guessMimeByExt(p);

    // Local safety for absolute paths.
    // IMPORTANT: only allow sending local files from an allowlist to avoid accidental exfil.
    if (!tempPath && p.startsWith('/')) {
      if (!isAllowedOutboundPath(p)) {
        if (DEBUG) console.log(`[DEBUG] outbound blocked by allowlist: ${p}`);
        // Don't spam users in normal mode; just skip this media.
        if (DEBUG) {
          await sendText(client, chatId, captionText ? `${captionText}\n（拒绝发送非白名单路径的本地文件）` : '（拒绝发送非白名单路径的本地文件）');
        }
        return;
      }
      const ok = safeFileSizeOk(p);
      if (!ok.ok) {
        if (DEBUG) {
          await sendText(client, chatId, captionText ? `${captionText}\n（附件过大或不可读：${ok.reason}）` : `（附件过大或不可读：${ok.reason}）`);
        }
        return;
      }
    }

    // Map types carefully to avoid Feishu error 230055.
    if (isProbablyImagePath(p)) {
      const res = await client.im.image.create({
        data: { image_type: 'message', image: fs.createReadStream(p) },
      });
      const imageKey = res?.data?.image_key || res?.image_key;
      if (!imageKey) throw new Error('upload image failed');

      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      });

      if (captionText?.trim()) await sendText(client, chatId, captionText.trim());
      return;
    }

    if (isProbablyVideoPath(p) && extLower(p) === 'mp4') {
      const res = await client.im.file.create({
        data: { file_type: 'mp4', file_name: path.basename(p), file: fs.createReadStream(p) },
      });
      const fileKey = res?.data?.file_key || res?.file_key;
      if (!fileKey) throw new Error('upload mp4 failed');

      // Important: msg_type must be "media" when file_type is mp4.
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'media', content: JSON.stringify({ file_key: fileKey }) },
      });

      if (captionText?.trim()) await sendText(client, chatId, captionText.trim());
      return;
    }

    // Audio: Feishu audio messages require opus; otherwise send as file.
    if (isProbablyAudioPath(p) && extLower(p) === 'opus') {
      const res = await client.im.file.create({
        data: { file_type: 'opus', file_name: path.basename(p), file: fs.createReadStream(p) },
      });
      const fileKey = res?.data?.file_key || res?.file_key;
      if (!fileKey) throw new Error('upload opus failed');

      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'audio', content: JSON.stringify({ file_key: fileKey }) },
      });

      if (captionText?.trim()) await sendText(client, chatId, captionText.trim());
      return;
    }

    // Default: send as file (stream)
    const res = await client.im.file.create({
      data: { file_type: 'stream', file_name: path.basename(p), file: fs.createReadStream(p) },
    });
    const fileKey = res?.data?.file_key || res?.file_key;
    if (!fileKey) throw new Error('upload file failed');

    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    });

    if (captionText?.trim()) await sendText(client, chatId, captionText.trim());
  } finally {
    if (tempPath) cleanupTempFile(tempPath);
  }
}

// ─── Slash commands ──────────────────────────────────────────────

async function handleSlashCommand(pm, alias, text) {
  const raw = String(text || '').trim();
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1] || '';
  const resolveTarget = (target) => pm.resolveTarget?.(alias, target) || target;

  if (cmd === '/help' || cmd === '/?') {
    return {
      text: [
        'Bridge 命令:',
        '',
        '/start [alias|all]  — 启动项目的 Codex 会话',
        '/stop [alias|all]   — 停止项目的 Codex 会话',
        '/reset [alias]      — 重置会话（清除历史，开始新对话）',
        '/clear [alias]      — 同 /reset',
        '/interrupt [alias]  — 打断当前正在处理的消息',
        '/status             — 查看所有项目状态',
        '/backup             — 立即触发一次备份',
        '/model [名称] [alias] — 查看或切换模型（如 glm-5.2 / qwen3.8-max）',
        '/hard [alias]       — 切换到 gpt-6.2-astra + high（下次消息生效）',
        '/cost [alias]       — 查看 token 用量',
        '/context [alias]    — 查看上下文窗口占用',
        '/compact [alias]    — 压缩会话历史',
        '/xx-dd 消息         — xx小时dd分钟后自动发送（一次）',
        '/scheduled [alias]  — 查看待发送定时任务',
        '/unschedule <id> [alias] — 撤回一个定时任务（支持 ID 前缀）',
        '/unschedule all [alias]  — 撤回该项目所有定时任务',
        '/help               — 显示此帮助',
        '',
        '其他 / 开头的消息会作为普通消息转发给 Codex。',
        'Codex 忙碌时追加的消息会优先并入当前轮次；失败时排队（群聊合并，私聊保留最新一条）。',
        '群聊 Slash 命令无需 @；普通消息仅响应 @ 当前机器人，其余消息累积为下次请求的背景。',
        '/clear 和 /reset 同时清空当前聊天尚未发送给 AI 的背景消息。',
        '',
        `当前项目: ${alias}`,
        `所有项目: ${pm.aliases().join(', ')}`,
      ].join('\n'),
    };
  }

  if (cmd === '/backup') {
    const backup = pm._config.backup;
    if (!backup) {
      return { text: '手动备份未启用；可在 bridge.json 中设置 backup.dest。' };
    }
    const result = await pm._runBackup(backup.dest);
    if (result.ok) {
      const sizeMb = result.sizeBytes ? ` (${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)` : '';
      return { text: `✅ 备份完成${sizeMb}\n路径: ${result.file}` };
    }
    return { text: `❌ 备份失败: ${result.error}` };
  }

  if (cmd === '/status') {
    const st = pm.status();
    const lines = ['项目状态:'];
    for (const [a, info] of Object.entries(st)) {
      const flag = info.started ? '🟢' : '🔴';
      const pid = info.pid ? `PID=${info.pid}` : '';
      const tokens = info.costUsd > 0 ? `${info.costUsd.toLocaleString()} tok` : '';
      const turns = info.turnCount > 0 ? `${info.turnCount}轮` : '';
      const session = info.sessionId ? `thread=${info.sessionId.slice(0, 8)}…` : '';
      const model = info.model ? `model=${info.model}` : '';
      const effort = info.reasoningEffort ? `effort=${info.reasoningEffort}` : '';
      const queued = pendingMessages.has(a) ? '📨 有排队消息' : '';
      const scheduledCount = getScheduledJobCount(a);
      const scheduled = scheduledCount > 0 ? `⏰ ${scheduledCount}个定时` : '';
      const bufferedCount = pm.groupMessages.count(a);
      const buffered = bufferedCount > 0 ? `💬 ${bufferedCount}条群聊背景` : '';
      const chat = info.chatType ? `${info.chatType}=${info.chatId}` : '';
      const details = [chat, pid, model, effort, tokens, turns, session, queued, scheduled, buffered].filter(Boolean).join(' ');
      lines.push(`${flag} ${a} (${info.path})${details ? ' — ' + details : ''}`);
    }
    return { text: lines.join('\n') };
  }

  if (cmd === '/scheduled') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };

    const jobs = listScheduledJobs(target);
    if (jobs.length === 0) {
      return { text: `项目 ${target} 当前没有待发送的定时任务。` };
    }
    const lines = [`项目 ${target} 的定时任务 (${jobs.length}):`];
    const nowMs = Date.now();
    for (const j of jobs) {
      const remainMs = Math.max(0, new Date(j.runAt).getTime() - nowMs);
      const remainH = Math.floor(remainMs / 3600000);
      const remainM = Math.floor((remainMs % 3600000) / 60000);
      const remainStr = remainMs > 0 ? `还剩 ${remainH}h${remainM}m` : '已到期';
      lines.push(`- ${j.jobId.slice(0, 8)}… | ${remainStr} | 触发: ${formatLocalDateTime(j.runAt)} | ${truncate(j.text, 80)}`);
    }
    lines.push('');
    lines.push('撤回示例: /unschedule <任务ID前缀> ' + target);
    return { text: lines.join('\n') };
  }

  if (cmd === '/unschedule') {
    const idOrAll = parts[1] || '';
    const target = resolveTarget(parts[2] || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };

    if (!idOrAll) {
      return { text: '用法: /unschedule <任务ID前缀> [alias]\n或: /unschedule all [alias]' };
    }

    if (idOrAll.toLowerCase() === 'all') {
      const count = cancelAllScheduledJobs(target);
      return { text: count > 0 ? `已撤回项目 ${target} 的 ${count} 个定时任务。` : `项目 ${target} 当前没有待发送的定时任务。` };
    }

    const canceled = cancelScheduledJobById(target, idOrAll);
    if (!canceled.ok) return { text: `错误: ${canceled.error}` };

    return {
      text: [
        '✅ 已撤回定时任务',
        `项目: ${target}`,
        `任务: ${canceled.jobId.slice(0, 8)}…`,
        `原计划: ${formatLocalDateTime(canceled.job.runAt)}`,
        `消息: ${canceled.job.text}`,
      ].join('\n'),
    };
  }

  if (cmd === '/start') {
    if (arg.toLowerCase() === 'all') {
      await pm.startAll();
      return { text: '所有项目已启动' };
    }
    const target = resolveTarget(arg || alias);
    const r = await pm.startProject(target);
    return { text: r.ok ? r.message : `错误: ${r.error}` };
  }

  if (cmd === '/stop') {
    if (arg.toLowerCase() === 'all') {
      await pm.stopAll();
      return { text: '所有项目已停止' };
    }
    const target = resolveTarget(arg || alias);
    const r = await pm.stopProject(target);
    return { text: r.ok ? r.message : `错误: ${r.error}` };
  }

  if (cmd === '/reset' || cmd === '/clear') {
    const target = resolveTarget(arg || alias);
    const r = await pm.resetProject(target);
    return { text: r.ok ? r.message : `错误: ${r.error}` };
  }

  if (cmd === '/interrupt') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj?.started) return { text: `项目 ${target} 未启动` };
    const ok = proj.agent.interrupt();
    return { text: ok ? `已发送打断信号给 ${target}` : `${target} 当前没有在处理消息` };
  }

  if (cmd === '/hard') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };
    if (!proj.started) return { text: `项目 ${target} 未启动，请先 /start。` };
    if (proj.agent.info().status === 'busy') {
      return { text: `项目 ${target} 正在处理消息，请先等待完成或 /interrupt 打断后再切换模型。` };
    }
    proj.agent._model = 'gpt-6.2-astra';
    proj.agent._reasoningEffort = 'high';
    return { text: `✅ 项目 ${target} 已切换到 gpt-6.2-astra + high\n下次消息起生效。` };
  }

  if (cmd === '/model') {
    const target = resolveTarget(parts[2] || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };

    if (!arg) {
      const info = proj.agent.info();
      const current = info.model || '(config.toml 默认)';
      const prov = info.provider || '(默认)';
      return {
        text: `项目 ${target} 当前模型: ${current} (推理强度: ${info.reasoningEffort || '默认'}, provider: ${prov})\n` +
          '用法: /model <模型名> [alias]\n' +
          '示例: /model glm-5.2\n      /model qwen3.8-max',
      };
    }

    if (proj.agent.info().status === 'busy') {
      return { text: `项目 ${target} 正在处理消息，请先等待完成或 /interrupt 打断后再切换模型。` };
    }

    // The new model is applied via the turn-level override on the next
    // turn/start (which also re-pins the thread default) — no process
    // restart needed. Provider switches stay in bridge.json (restart).
    proj.agent._model = arg;
    return { text: `✅ 项目 ${target} 已切换模型: ${arg}\n下次消息起生效。` };
  }

  if (cmd === '/cost') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };
    const info = proj.agent.info();
    const usage = proj.agent._lastUsage;
    const lines = [
      `项目 ${target} token 用量:`,
      `模型: ${info.model || '(config.toml 默认)'} (provider: ${info.provider || '默认'})`,
      `累计: ${info.costUsd.toLocaleString()} tokens / ${info.turnCount} 轮`,
    ];
    if (usage?.last) {
      lines.push(
        `上一轮: 输入 ${Number(usage.last.inputTokens || 0).toLocaleString()}` +
        `（缓存命中 ${Number(usage.last.cachedInputTokens || 0).toLocaleString()}）` +
        ` / 输出 ${Number(usage.last.outputTokens || 0).toLocaleString()}`,
      );
    }
    lines.push('（不同 provider 计价不同，此处只统计 token 数）');
    return { text: lines.join('\n') };
  }

  if (cmd === '/context') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };
    const usage = proj.agent._lastUsage;
    if (!usage?.total) {
      return { text: `项目 ${target} 还没有用量数据，先发一条消息。` };
    }
    // Occupancy = last turn's total tokens (input+output ≈ active context),
    // matching codex TUI's context-remaining calculation. `total` is the
    // cumulative sum across ALL turns and must not be used as occupancy.
    const used = Number(usage.last?.totalTokens || 0);
    const win = Number(usage.modelContextWindow || 0);
    const pct = win > 0 ? ` (${((used / win) * 100).toFixed(1)}%)` : '';
    const lines = [
      `项目 ${target} 上下文占用:`,
      win > 0
        ? `${used.toLocaleString()} / ${win.toLocaleString()} tokens${pct}`
        : `${used.toLocaleString()} tokens（上下文窗口大小未知）`,
      `累计消耗: ${Number(usage.total?.totalTokens || 0).toLocaleString()} tokens`,
    ];
    if (win > 0 && used / win > 0.75) {
      lines.push('占用偏高，可用 /compact 压缩会话历史。');
    }
    return { text: lines.join('\n') };
  }

  if (cmd === '/compact') {
    const target = resolveTarget(arg || alias);
    const proj = pm.getProject(target);
    if (!proj) return { text: `错误: 未知项目 ${target}` };
    if (!proj.started) return { text: `项目 ${target} 未启动` };
    const r = await proj.agent.compact();
    return { text: r.ok ? `已触发 ${target} 的会话压缩，进度见后续消息。` : `压缩失败: ${r.error}` };
  }

  // Unknown slash command — pass through to Codex as a normal message
  return null;
}

// ─── Message queue (private: latest message; group: merged batches) ──

const pendingMessages = new Map(); // alias → { text, chatId, channel, thresholdMs }
const scheduledMessages = new Map(); // alias → Map<jobId, { timer, chatId, text, runAt, thresholdMs }>
let channelMap = new Map();  // alias → LarkChannel (module-level for saveAndExit access)

function saveScheduledMessages() {
  try {
    const data = {};
    for (const [alias, jobs] of scheduledMessages) {
      data[alias] = [];
      for (const [jobId, job] of jobs) {
        data[alias].push({
          jobId,
          chatId: job.chatId,
          text: job.text,
          runAt: job.runAt,
          thresholdMs: job.thresholdMs,
          chatType: job.chatType,
        });
      }
    }
    fs.mkdirSync(path.dirname(SCHEDULED_PATH), { recursive: true });
    const tmp = SCHEDULED_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, SCHEDULED_PATH);
  } catch (e) {
    console.error(`[WARN] Failed to save scheduled messages: ${e?.message || String(e)}`);
  }
}

async function resolveScheduledConversation(pm, alias, job, channel) {
  const project = pm.getProject(alias);
  if (!project) return null;
  let chatType = job.chatType || (project.chatId === job.chatId ? project.chatType : null);
  if (!chatType) {
    const mode = await withTimeout(channel.getChatMode(job.chatId), 8000, 'Scheduled message chat lookup timed out');
    chatType = mode === 'p2p' ? 'p2p' : 'group';
  }
  return pm.getConversation(project.projectAlias, chatType, job.chatId);
}

async function restoreScheduledMessages(pm, channelMap, thresholdMs) {
  if (!fs.existsSync(SCHEDULED_PATH)) return 0;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8'));
  } catch {
    return 0;
  }

  const now = Date.now();
  let count = 0;
  for (const [alias, jobs] of Object.entries(data)) {
    if (!Array.isArray(jobs)) continue;
    const project = pm.getProject(alias);
    const channel = channelMap.get(project?.projectAlias || alias);
    if (!channel || !project) continue;
    for (const job of jobs) {
      const { jobId, chatId, text, runAt, thresholdMs: jobThresholdMs } = job;
      if (!jobId || !chatId || !text || !runAt) continue;
      const runAtMs = new Date(runAt).getTime();
      if (isNaN(runAtMs)) continue;
      let conversation;
      try {
        conversation = await resolveScheduledConversation(pm, alias, job, channel);
      } catch (e) {
        console.warn(`[SCHED] Cannot restore ${jobId}: ${e.message}`);
        continue;
      }
      if (!conversation) continue;
      const targetAlias = conversation.alias;

      // Already past — fire immediately with a late notice
      const delayMs = Math.max(0, runAtMs - now);
      const isLate = runAtMs < now;

      const timer = setTimeout(() => {
        void (async () => {
          clearScheduledJob(targetAlias, jobId);
          saveScheduledMessages();

          if (isLate) {
            try {
              await sendText(channel, chatId, `⏰ 定时消息（延迟送达，原定 ${formatLocalDateTime(runAt)}）：\n${text}`, true);
            } catch {}
            return;
          }

          const proj = pm.getProject(targetAlias);
          if (!proj?.started) {
            try {
              await sendText(channel, chatId, `⏰ 定时消息未发送：项目 ${targetAlias} 未启动。\n消息内容：${text}`, true);
            } catch {}
            return;
          }

          const queued = queuePendingMessage(pm, targetAlias, { text, chatId, channel, thresholdMs: jobThresholdMs ?? thresholdMs });
          if (proj.replyPending || proj.agent.info().status === 'busy') {
            let note = '⏰ 定时消息已到点，已加入队列。';
            if (queued.had) note += queued.merged ? '\n（已合并之前排队的群聊消息）' : '\n（已替换之前排队的消息）';
            try { await sendText(channel, chatId, note, true); } catch {}
            return;
          }
          try { await sendText(channel, chatId, `⏰ 定时消息已发送：${text}`, true); } catch {}
          await drainQueue(pm, targetAlias);
        })();
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();

      let jobs2 = scheduledMessages.get(targetAlias);
      if (!jobs2) { jobs2 = new Map(); scheduledMessages.set(targetAlias, jobs2); }
      jobs2.set(jobId, { timer, chatId, text, runAt, chatType: conversation.project.chatType, thresholdMs: jobThresholdMs ?? thresholdMs });
      count++;
    }
  }
  if (count > 0) console.log(`[SCHED] 已恢复 ${count} 条定时消息`);
  return count;
}

function clearScheduledJob(alias, jobId) {
  const jobs = scheduledMessages.get(alias);
  if (!jobs) return;
  jobs.delete(jobId);
  if (jobs.size === 0) scheduledMessages.delete(alias);
}

function getScheduledJobCount(alias) {
  return scheduledMessages.get(alias)?.size || 0;
}

function listScheduledJobs(alias) {
  const jobs = scheduledMessages.get(alias);
  if (!jobs || jobs.size === 0) return [];
  return [...jobs.entries()]
    .map(([jobId, job]) => ({ jobId, ...job }))
    .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());
}

function cancelAllScheduledJobs(alias) {
  const jobs = scheduledMessages.get(alias);
  if (!jobs || jobs.size === 0) return 0;
  let count = 0;
  for (const [jobId, job] of jobs) {
    try { clearTimeout(job.timer); } catch {}
    clearScheduledJob(alias, jobId);
    count++;
  }
  saveScheduledMessages();
  return count;
}

function cancelScheduledJobById(alias, idOrPrefix) {
  const jobs = scheduledMessages.get(alias);
  if (!jobs || jobs.size === 0) {
    return { ok: false, error: '当前没有待发送的定时任务。' };
  }
  const key = String(idOrPrefix || '').trim();
  if (!key) {
    return { ok: false, error: '请提供任务 ID（可用前缀），例如 /unschedule a1b2c3d4' };
  }

  const matches = [...jobs.entries()].filter(([jobId]) => jobId === key || jobId.startsWith(key));
  if (matches.length === 0) {
    return { ok: false, error: `未找到任务: ${key}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `匹配到多个任务，请提供更长 ID 前缀: ${key}` };
  }

  const [jobId, job] = matches[0];
  try { clearTimeout(job.timer); } catch {}
  clearScheduledJob(alias, jobId);
  saveScheduledMessages();
  return { ok: true, jobId, job };
}

function scheduleOneOffMessage(pm, alias, chatId, channel, thresholdMs, payload) {
  const runAt = computeDelayScheduleTime(payload.hours, payload.minutes);
  const delayMs = Math.max(0, runAt.getTime() - Date.now());
  const jobId = uuid();

  const timer = setTimeout(() => {
    void (async () => {
      clearScheduledJob(alias, jobId);
      saveScheduledMessages();

      const proj = pm.getProject(alias);
      if (!proj?.started) {
        try {
          await sendText(
            channel,
            chatId,
            `⏰ 定时消息未发送：项目 ${alias} 未启动。\n消息内容：${payload.text}`,
            true,
          );
        } catch {}
        return;
      }

      const queued = queuePendingMessage(pm, alias, {
        text: payload.text,
        chatId,
        channel,
        thresholdMs,
      });

      if (proj.replyPending || proj.agent.info().status === 'busy') {
        let note = '⏰ 定时消息已到点，已加入队列。';
        if (queued.had) note += queued.merged ? '\n（已合并之前排队的群聊消息）' : '\n（已替换之前排队的消息）';
        try { await sendText(channel, chatId, note, true); } catch {}
        return;
      }

      try { await sendText(channel, chatId, `⏰ 定时消息已发送：${payload.text}`, true); } catch {}
      await drainQueue(pm, alias);
    })();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();

  let jobs = scheduledMessages.get(alias);
  if (!jobs) {
    jobs = new Map();
    scheduledMessages.set(alias, jobs);
  }
  jobs.set(jobId, {
    timer,
    chatId,
    text: payload.text,
    runAt: runAt.toISOString(),
    thresholdMs,
    chatType: pm.getProject(alias)?.chatType,
  });
  saveScheduledMessages();

  return { jobId, runAt };
}

/**
 * Send Codex's reply back to Feishu.
 * @param {object} replyCtx - { incomingMessageId, reactionId, notice };
 *   notice marks bridge-generated control replies, never AI conclusions.
 */
async function sendReplyToFeishu(channel, chatId, replyText, replyCtx) {
  const { incomingMessageId, reactionId, notice = false } = replyCtx || {};

  // Clean up typing indicator reaction first
  if (incomingMessageId && reactionId) {
    await removeReaction(channel.rawClient, incomingMessageId, reactionId);
  }

  const parsed = parseMediaLines(replyText);
  replyText = parsed.text;
  let mediaUrls = parsed.mediaUrls || [];

  const mdPaths = extractMarkdownLocalMediaPaths(replyText);
  if (mdPaths.length > 0) {
    for (const pth of mdPaths) {
      const fp = path.resolve(pth);
      if (isAllowedOutboundPath(fp)) mediaUrls.push(fp);
    }
    replyText = stripMarkdownLocalMediaRefs(replyText);
  }

  mediaUrls = [...new Set(mediaUrls)].slice(0, 4);

  const trimmedText = (replyText || '').trim();
  if ((!trimmedText || trimmedText === 'NO_REPLY' || trimmedText.endsWith('NO_REPLY')) && mediaUrls.length === 0) {
    return;
  }

  if (trimmedText.endsWith('NO_REPLY')) {
    replyText = trimmedText.replace(/\s*NO_REPLY\s*$/g, '').trim();
  }

  try {
    if (mediaUrls.length > 0) {
      for (const u of mediaUrls.slice(0, 4)) {
        await uploadAndSendMedia(channel.rawClient, chatId, u, undefined);
      }
      if (replyText?.trim()) {
        await sendText(channel, chatId, replyText.trim(), notice);
      }
      return;
    }

    // Auto-detect markdown content: use interactive card for rich rendering
    if (shouldUseMarkdownCard(replyText)) {
      try {
        await sendMarkdownCard(channel, chatId, replyText, incomingMessageId, notice);
        return;
      } catch {
        // Card rendering failed (e.g. too many tables, ErrCode 11310) — fall back to plain text
      }
    }

    await sendText(channel, chatId, replyText, notice);
  } catch (err) {
    try {
      await sendText(channel, chatId, `（发送失败）${err instanceof Error ? err.message : String(err)}`, true);
    } catch {}
  }
}

/**
 * Process a Codex message and stream the reply to Feishu.
 *
 * Uses Feishu's native streaming card (typewriter effect + auto-rollover
 * for content exceeding 30KB). Falls back to non-streaming send
 * (sendReplyToFeishu) if the stream fails to start.
 *
 * @param {CodexAppServer} agent
 * @param {string} text - user message to send to Codex
 * @param {object} channel - LarkChannel instance
 * @param {string} chatId
 * @param {{ incomingMessageId?: string, reactionId?: string|null, canSend?: () => boolean }} replyCtx
 * @returns {Promise<{text:string,sessionId:string,costUsd:number,interrupted?:boolean}|null>}
 */
async function processAndReply(agent, text, channel, chatId, replyCtx) {
  const { incomingMessageId } = replyCtx || {};
  const sendMessage = (options) => {
    if (replyCtx?.canSend && !replyCtx.canSend()) throw new Error('会话已重置或停止，本次请求已取消');
    return agent.sendMessage(text, options);
  };

  const streamOpts = incomingMessageId ? { replyTo: incomingMessageId } : {};
  let cardCreated = false;
  let finalResult = null;
  // controller ref stashed so we can inspect `streamingFailed` after the
  // stream completes (the SDK swallows update errors internally and only flips
  // this flag — see MarkdownStreamControllerImpl.pushContent).
  let streamController = null;
  // Lifted into the outer scope so the catch block can fall back to a plain
  // message if the streaming card never received the final content.
  let finalDisplayText = null;
  // Some conclusions bypass the streaming card and ship on a fresh
  // non-streaming card instead (see below): table-heavy conclusions (Feishu's
  // streaming element silently drops table content) and long turns (the
  // streaming element has a hard lifetime — past ~10–47min, content PATCHes
  // are silently dropped even with heartbeats keeping the card alive).
  let bypassStreamingCard = false;

  try {
    await channel.stream(chatId, {
      markdown: async (controller) => {
        cardCreated = true;
        streamController = controller;

        // Show a "thinking" placeholder immediately so the user sees
        // the card is being worked on (no blank-slate silence).
        let hasRealContent = false;
        controller.setContent('💭 正在思考…').catch(() => {});

        // Process card shows ONLY progress (thinking / tool activity), never
        // partial answer text. Pushing partial text burned through the Feishu
        // streaming card edit budget (~50 edits/card) and, when exhausted, the
        // final setContent failed silently → the conclusion never showed.
        // Now edits happen only on tool-type transitions (≪ tool call count),
        // so the budget is plenty for the final setContent at the end.
        // PROGRESS_EDIT_CAP reserves headroom: stop updating progress after this
        // many edits so the final setContent always has budget left. Was 30, but
        // tool-heavy turns (50+ tool calls, lots of type transitions) hit the cap
        // and combined with heartbeats exhausted the per-card edit budget (~40,
        // not 50 as once thought) → final conclusion PATCH silently dropped
        // (Feishu returns 200, doesn't render, streamingFailed stays false).
        // 15 keeps worst case ≈ 15 progress + 5 heartbeat/10min + 3 overhead
        // ≈ 23, safely under the limit.
        const PROGRESS_EDIT_CAP = 15;
        // Heartbeat: PATCH the card every ~120s for the whole turn so Feishu
        // never auto-closes the streaming card (it does after 10min of
        // inactivity). 120s is still far inside the 10min window but halves the
        // edit-budget pressure vs 60s. Without this, a long thinking/tool phase
        // silences the card after the progress cap → Feishu auto-closes at 10min
        // → the final conclusion setContent PATCH hits an already-closed card
        // (Feishu returns 200 but doesn't render) → silent loss
        // (streamingFailed stays false).
        const HEARTBEAT_INTERVAL_MS = 120_000;
        let progressEditCount = 0;
        let lastActivityKey = '';
        const turnStartAt = Date.now();
        let lastHeartbeatAt = turnStartAt;
        const progressTimer = setInterval(() => {
          // Dense progress edits on tool transitions, until the cap or until
          // real answer text starts. Process card shows ONLY progress, never
          // partial answer text (pushing partial text burned the ~50-edit/card
          // budget and left nothing for the final setContent).
          if (!hasRealContent && progressEditCount < PROGRESS_EDIT_CAP) {
            const act = agent._lastActivity;
            if (act) {
              // Key = activity type + tool name (ignore timestamp)
              const key = `${act.type}:${act.tool || ''}`;
              if (key !== lastActivityKey) {
                lastActivityKey = key;
                const progress = agent.progressText();
                if (progress) {
                  progressEditCount++;
                  controller.setContent(`💭 ${progress}`).catch(() => {});
                  lastHeartbeatAt = Date.now();
                }
              }
            }
          }
          // Keep-alive heartbeat: PATCH every ~60s for the ENTIRE turn
          // (regardless of hasRealContent) so Feishu never auto-closes the
          // streaming card. Critical: the heartbeat must NOT be gated on
          // !hasRealContent — a model often emits a sentence of text, THEN
          // runs a long tool phase, THEN produces the final answer. If the
          // heartbeat stopped once text appeared, the long tool phase would
          // silence the card → Feishu 10min auto-close → final conclusion
          // PATCH hits a closed card (200 but not rendered) → silent loss.
          // 60s is sparse enough that the ~50-edit/card budget lasts ~50min
          // before rollover kicks in.
          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatAt = now;
            const elapsedMin = Math.max(1, Math.round((now - turnStartAt) / 60000));
            controller.setContent(`⏳ 仍在处理…（已 ${elapsedMin} 分钟）`).catch(() => {});
            // Log liveness sparsely: first tick + every 5 min. The PATCH still
            // fires every 60s (keep-alive), we just don't log each one.
            if (elapsedMin === 1 || elapsedMin % 5 === 0) {
              console.warn('[concl] heartbeat min=%d seq=%d', elapsedMin, controller.sequence);
            }
          }
        }, 1500);

        try {
          finalResult = await sendMessage({
            // onStream no longer pushes partial text to the card. We only use
            // it to detect when real answer text starts (vs tool markers) so
            // we can switch the card to a "generating" marker once. Tool
            // progress is already handled by progressTimer above.
            onStream: () => {
              if (hasRealContent || !agent._hasAssistantText) return;
              hasRealContent = true;
              // Note: do NOT clearInterval(progressTimer) here — the heartbeat
              // must keep running (see comment in progressTimer). hasRealContent
              // already stops the dense progress edits above.
              if (progressEditCount < PROGRESS_EDIT_CAP) {
                progressEditCount++;
                controller.setContent('✍️ 正在生成回复…').catch(() => {});
                lastHeartbeatAt = Date.now();
              }
            },
          });
        } finally {
          clearInterval(progressTimer);
        }

        // Final update with clean result text
        if (finalResult?.interrupted) {
          finalDisplayText = '⚡ 当前处理已被打断';
        } else {
          const rawText = String(finalResult?.text ?? '');
          const parsed = parseMediaLines(rawText);
          finalDisplayText = stripMarkdownLocalMediaRefs(parsed.text);
          if (finalDisplayText.endsWith('NO_REPLY')) {
            finalDisplayText = finalDisplayText.replace(/\s*NO_REPLY\s*$/g, '').trim();
          }
          if (!finalDisplayText.trim()) {
            const costNote = finalResult?.costUsd > 0 ? ` ($${finalResult.costUsd})` : '';
            finalDisplayText = `✅ 已执行（无输出）${costNote}`;
          }
        }
        // Table-heavy conclusions blow past Feishu's per-card table limit →
        // ErrCode 11310 "card table number over limit" → the card stops
        // rendering mid-content and the user sees only the pre-table half
        // (the table portion is silently lost). Detect up-front: for
        // table-heavy conclusions, DON'T put the conclusion on the streaming
        // card — finalize it to a marker and deliver the conclusion via a
        // fresh non-streaming card below (which falls back to plain text on
        // 11310, so the full text always reaches the user).
        // Feishu's streaming card element silently fails to render markdown
        // tables (PATCH returns 200 but the table content isn't applied — the
        // card freezes on the previous marker). Was 2, but even 2 tables trigger
        // the silent failure (observed 2026-07-03: a 2-table conclusion with
        // seq=14, well under the edit budget, still didn't render). Any table →
        // bypass the streaming card and deliver via a fresh non-streaming card
        // (sendReplyToFeishu renders tables correctly, and falls back to plain
        // text on 11310 so the full content always reaches the user).
        const TABLE_LIMIT = 0;
        const tableCount = (finalDisplayText.match(/\n\|.+\|\n\|[-:| ]+\|/g) || []).length;
        const tableHeavy = tableCount > TABLE_LIMIT;
        // Long turns: the streaming card element has a hard lifetime — past
        // ~10–47min, content PATCHes are silently dropped even with heartbeats
        // (observed 2026-07-03: a 47-min turn, seq=28, heartbeats firing every
        // 120s throughout, matches=true, streamingFailed=false — yet the final
        // conclusion never rendered). 8min is safely under the observed failure
        // point; for turns past it, finalize the streaming card to a marker and
        // deliver the conclusion on a fresh non-streaming card below.
        const LONG_TURN_MS = 8 * 60_000;
        const turnElapsedMs = Date.now() - turnStartAt;
        const longTurn = turnElapsedMs > LONG_TURN_MS;
        bypassStreamingCard = tableHeavy || longTurn;

        // Best-effort final push. The SDK schedules this through its throttle
        // queue; if the underlying PUT fails (e.g. ECONNRESET, 11310 table
        // over limit) the SDK may swallow the error and flip `streamingFailed`
        // — we detect that below and re-deliver via a plain message. If
        // setContent itself throws, re-deliver immediately here too.
        try {
          if (bypassStreamingCard) {
            console.warn('[concl] bypass streaming card (%s) → deliver via non-stream card; tables=%d elapsedMs=%d',
              longTurn ? (tableHeavy ? 'long-turn+table-heavy' : 'long-turn') : 'table-heavy',
              tableCount, turnElapsedMs);
            await controller.setContent('✅ 完成（见下方）');
          } else {
            await controller.setContent(finalDisplayText);
          }
        } catch (e) {
          console.warn('[stream] final setContent threw:', e?.message || String(e));
          // Card rejected the content (e.g. 11310 table over limit) —
          // re-deliver the full conclusion as a fresh non-streaming card so
          // nothing is lost.
          try {
            await sendReplyToFeishu(channel, chatId, finalDisplayText, { incomingMessageId });
          } catch (e2) {
            console.error('[concl] setContent-throw fallback failed:', e2?.message || String(e2));
          }
        }
      },
    }, streamOpts);

    // [concl] one concise line per turn with the signals that matter for
    // diagnosing lost conclusions: did Codex produce text, did the SDK patch
    // it (seq>0, matches), did a PATCH throw (streamingFailed), did it
    // rollover or exceed the element limit.
    if (streamController) {
      const sc = streamController;
      const scContent = String(sc.content || '');
      console.warn(
        '[concl] turn end: interrupted=%s textLen=%d finalLen=%d seq=%d streamingFailed=%s matches=%s rollovers=%d overLimit=%s',
        !!finalResult?.interrupted,
        String(finalResult?.text ?? '').length,
        (finalDisplayText || '').length,
        sc.sequence,
        sc.streamingFailed,
        scContent === finalDisplayText,
        sc.rolloverMessageIds?.length,
        scContent.length > (sc.maxChars || 30000),
      );
    }

    // Stream completed (SDK ran completeTerminal). If the final card update
    // failed transitively, streamingFailed is now true — re-deliver the
    // conclusion as a plain message so the user is not left staring at a
    // stuck "✍️ 正在生成回复…" progress marker.
    if (streamController?.streamingFailed) {
      console.warn('[stream] final card update failed (streamingFailed), falling back to plain message');
      try {
        await sendReplyToFeishu(channel, chatId, finalDisplayText ?? '', { incomingMessageId });
      } catch (e) {
        console.error('[stream] fallback plain message also failed:', e?.message || String(e));
      }
    }

    // Conclusions that bypassed the streaming card (table-heavy or long-turn)
    // were finalized to "✅ 完成（见下方）" above. Deliver the real conclusion
    // now as a fresh non-streaming card — sendReplyToFeishu falls back to plain
    // text on 11310, so the full content always reaches the user even if the
    // card can't render the tables.
    if (bypassStreamingCard) {
      try {
        await sendReplyToFeishu(channel, chatId, finalDisplayText ?? '', { incomingMessageId });
      } catch (e) {
        console.error('[concl] bypass delivery failed:', e?.message || String(e));
      }
    }
    return finalResult;
  } catch (e) {
    if (!cardCreated) {
      // Stream failed to start — fall back to non-streaming send.
      // Show a "thinking" placeholder immediately so the user isn't
      // left staring at silence while Codex processes.
      console.warn('[WARN] stream failed to start, falling back:', e?.message || String(e));
      let placeholderMsgId = null;

      // Helper: send/replace the placeholder with updated progress text
      const updatePlaceholder = async (msgText) => {
        try {
          // Delete old placeholder first
          if (placeholderMsgId) {
            try { await channel.rawClient.im.v1.message.delete({ path: { message_id: placeholderMsgId } }); } catch {}
          }
          const phRes = await sendText(channel, chatId, msgText, true);
          placeholderMsgId = phRes?.messageId || phRes?.data?.message_id || null;
        } catch {}
      };

      await updatePlaceholder('💭 正在思考…');

      // Periodically update placeholder with elapsed time & activity
      const fallbackTimer = setInterval(async () => {
        const progress = agent.progressText();
        if (progress) {
          await updatePlaceholder(`💭 ${progress}`);
        }
      }, 3000);

      try {
        const result = await sendMessage();
        clearInterval(fallbackTimer);
        const replyText = result?.interrupted ? '⚡ 当前处理已被打断' : String(result?.text ?? '');
        await sendReplyToFeishu(channel, chatId, replyText, { incomingMessageId, notice: Boolean(result?.interrupted) });
        // Delete the placeholder now that the real reply is sent
        if (placeholderMsgId) {
          try { await channel.rawClient.im.v1.message.delete({ path: { message_id: placeholderMsgId } }); } catch {}
        }
        return result;
      } catch (e2) {
        clearInterval(fallbackTimer);
        await sendReplyToFeishu(channel, chatId, `（系统出错）${e2?.message || String(e2)}`, { incomingMessageId, notice: true });
        return null;
      }
    }
    // Stream started but producer failed — SDK already showed error in card.
    // Don't swallow silently: log it, and if we already computed the final
    // text, re-deliver it as a plain message so the conclusion survives.
    console.error('[WARN] stream failed after card creation:', e?.message || String(e));
    if (finalDisplayText) {
      try {
        await sendReplyToFeishu(channel, chatId, finalDisplayText, { incomingMessageId });
      } catch (e2) {
        console.error('[stream] post-failure fallback also failed:', e2?.message || String(e2));
      }
    }
  }

  // Send media files from the final result (after stream completes)
  if (finalResult?.text && !finalResult?.interrupted) {
    const rawText = String(finalResult.text);
    const parsed = parseMediaLines(rawText);
    let mediaUrls = parsed.mediaUrls || [];
    const mdPaths = extractMarkdownLocalMediaPaths(parsed.text);
    if (mdPaths.length > 0) {
      for (const pth of mdPaths) {
        const fp = path.resolve(pth);
        if (isAllowedOutboundPath(fp)) mediaUrls.push(fp);
      }
    }
    mediaUrls = [...new Set(mediaUrls)].slice(0, 4);
    for (const u of mediaUrls) {
      try {
        await uploadAndSendMedia(channel.rawClient, chatId, u, undefined);
      } catch (e) {
        console.error(`[WARN] media send failed after stream: ${e?.message || String(e)}`);
      }
    }
  }

  return finalResult;
}

async function drainQueue(pm, alias) {
  const proj = pm.getProject(alias);
  if (!proj?.started) return;
  if (proj.replyPending || proj.agent.info().status === 'busy') return;

  const entry = pendingMessages.get(alias);
  if (!entry) return;
  pendingMessages.delete(alias);

  const { text, chatId, channel, thresholdMs, incomingMessageId, groupRecords } = entry;
  proj.replyPending = true;
  let accepted = false;
  const generation = proj.generation;

  let reactionId = null;
  let done = false;

  const timer = thresholdMs > 0
    ? setTimeout(async () => {
        if (done) return;
        if (incomingMessageId) {
          reactionId = await addReaction(channel.rawClient, incomingMessageId, 'Typing');
        }
      }, thresholdMs)
    : null;

  try {
    // Clear timer and remove any already-added reaction BEFORE streaming
    // (the streaming card's "Thinking..." state replaces the reaction indicator)
    if (timer) clearTimeout(timer);
    if (incomingMessageId && reactionId) {
      await removeReaction(channel.rawClient, incomingMessageId, reactionId);
    }
    accepted = Boolean(await processAndReply(proj.agent, text, channel, chatId, {
      incomingMessageId, canSend: () => proj.started && proj.generation === generation,
    }));
  } catch (e) {
    console.error(`[ERROR] drainQueue: ${e?.message || String(e)}`);
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    proj.replyPending = false;
    if (groupRecords && !accepted && proj.generation === generation) {
      try { pm.groupMessages.restore(alias, groupRecords); }
      catch (e) { console.error('[ERROR] queued group buffer persistence:', e); }
    }
  }

  await drainQueue(pm, alias);
}

// ─── Card action handler ──────────────────────────────────────────

function handleCardAction(pm, alias, evt) {
  try {
    const action = evt?.action;
    const value = action?.value || {};

    if (value.action === 'interrupt') {
      const proj = pm.getProject(alias);
      if (proj?.started && proj.agent.info().status === 'busy') {
        const ok = proj.agent.interrupt();
        console.log(`[cardAction] interrupt on "${alias}": ${ok}`);
      }
    }
  } catch (e) {
    console.error('[cardAction] error:', e);
  }
}

function createFeishuChannel(appId, appSecret, notices) {
  const channel = Lark.createLarkChannel({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
    source: 'feishu-codes-bridge',
    loggerLevel: Lark.LoggerLevel.info,
    // The SDK default cache is process-global, and its message dedup keys
    // omit appId. Bots in the same group receive identical message IDs.
    cache: new Lark.DefaultCache(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      // Let the bridge accumulate @all messages; only its own @ gate replies.
      respondToMentionAll: true,
    },
    safety: { chatQueue: { enabled: false } },
    includeRawEvent: true,
    outbound: { streamThrottleMs: 400 },
    wsConfig: { pingTimeout: 3 },
    handshakeTimeoutMs: 8000,
  });
  channel.bridgeNotices = notices;
  return channel;
}

// ─── NormalizedMessage handler (SDK 1.66+ createLarkChannel) ─────

function isBridgeCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  return ['/help', '/?', '/backup', '/status', '/scheduled', '/unschedule',
    '/start', '/stop', '/reset', '/clear', '/interrupt', '/hard', '/model',
    '/cost', '/context', '/compact'].includes(cmd)
    || /^\/\d+-\d+(?:\s|$)/.test(text) || isLegacyClockScheduleCommand(text);
}

function queuePendingMessage(pm, alias, entry) {
  const previous = pendingMessages.get(alias);
  const merge = previous && pm.getProject(alias)?.chatType === 'group';
  pendingMessages.set(alias, merge ? {
    ...entry,
    text: `${previous.text}\n\n${entry.text}`,
    groupRecords: [...(previous.groupRecords || []), ...(entry.groupRecords || [])],
  } : entry);
  return { had: Boolean(previous), merged: Boolean(merge) };
}

function createNormalizedMessageHandler(pm, projectAlias, channel, thresholdMs) {
  return async (msg) => {
    let reservedRecords = null;
    let accepted = false;
    let alias = projectAlias;
    let generation = null;
    let mayReply = false;
    try {
      const { chatId, messageId, chatType } = msg;
      if (!chatId || !messageId || !['p2p', 'group'].includes(chatType)) return;
      if (isOwnMessage(msg, channel.botIdentity)) return;
      if (pm.notices.isNotice(msg)) return;
      const text = String(msg.content || '').trim();
      const resources = msg.resources || [];
      const isSlash = text.startsWith('/') && resources.length === 0;
      const mentioned = isBotMentioned(msg, channel.botIdentity);
      mayReply = chatType === 'p2p' || mentioned || isSlash;
      if (isDuplicate(`${channel.botIdentity?.openId || projectAlias}:${messageId}`)) return;
      const conversation = pm.getConversation(projectAlias, chatType, chatId);
      if (!conversation) return;
      alias = conversation.alias;
      const proj = conversation.project;
      generation = proj.generation;
      const isGroup = chatType === 'group';
      const record = isGroup ? groupMessageRecord(msg) : null;
      if (isGroup && !mayReply) {
        pm.groupMessages.append(alias, record);
        return;
      }

      const controlCommand = isSlash && isBridgeCommand(text);
      // Reserve at receipt time, before sending cards or making RPC calls.
      // Slash commands work without @ and retain background messages.
      // /clear and /reset explicitly clear them; @ AI requests consume them.
      if (isGroup && mentioned && !controlCommand) {
        if (proj.started) reservedRecords = [...pm.groupMessages.take(alias), record];
        else pm.groupMessages.append(alias, record);
      }
      const fullText = reservedRecords
        ? buildGroupPrompt(reservedRecords.slice(0, -1), record)
        : [text, ...resources.map((res) => `[附件: ${res.fileName || res.type || 'attachment'}]`)].filter(Boolean).join('\n');

      let replyText = null;
      if (controlCommand) {
        if (isLegacyClockScheduleCommand(text)) {
          replyText = '定时语法已更新：请使用 /xx-dd 消息\n例如: /2-15 两小时十五分钟后发送';
        } else {
          const scheduleCmd = parseDelayedSendCommand(text);
          if (scheduleCmd) {
            if ('error' in scheduleCmd) replyText = `错误: ${scheduleCmd.error}`;
            else if (!proj.started) replyText = `项目 ${alias} 未启动。发送 /start 启动。`;
            else {
              const scheduled = scheduleOneOffMessage(pm, alias, chatId, channel, thresholdMs, scheduleCmd);
              replyText = [
                '⏰ 已设置定时发送（一次）',
                `延迟: ${scheduleCmd.hours}小时 ${scheduleCmd.minutes}分钟`,
                `计划时间: ${formatLocalDateTime(scheduled.runAt)}`,
                `消息: ${scheduleCmd.text}`,
                `任务: ${scheduled.jobId.slice(0, 8)}…`,
              ].join('\n');
            }
          } else {
            const result = await handleSlashCommand(pm, alias, text);
            replyText = String(result?.text ?? '');
          }
        }
      } else if (!proj.started) {
        replyText = `项目 ${alias} 未启动。发送 /start 启动。`;
      } else if (proj.replyPending || proj.agent.info().status === 'busy') {
        // Serialize steering attempts so several simultaneous @ requests cannot
        // overtake each other or replace a previously reserved group batch.
        const steer = async () => {
          if (!proj.started || proj.generation !== generation || pendingMessages.has(alias)
            || proj.agent.info().status !== 'busy') return { ok: false };
          return proj.agent.steer(fullText);
        };
        const steering = (proj.steerLock || Promise.resolve()).then(steer);
        proj.steerLock = steering.catch(() => {});
        const result = await steering;
        if (!proj.started || proj.generation !== generation) return;
        if (result.ok) {
          accepted = true;
          replyText = '⤴️ 已并入当前处理轮次。';
        } else {
          const queued = queuePendingMessage(pm, alias, {
            text: fullText, chatId, channel, thresholdMs, incomingMessageId: messageId,
            groupRecords: reservedRecords,
          });
          accepted = true;
          replyText = '⏳ Codex 正在处理上一条消息，你的消息已排队。\n回复 /interrupt 可打断当前处理。';
          if (queued.had) replyText += queued.merged
            ? '\n（已合并群聊中之前排队的消息）' : '\n（已替换之前排队的消息）';
        }
      } else {
        // Claim the conversation before awaiting streaming-card creation.
        // sendMessage() claims busy only once the SDK calls the producer.
        proj.replyPending = true;
        try {
          const result = await processAndReply(proj.agent, fullText, channel, chatId, {
            incomingMessageId: messageId, canSend: () => proj.started && proj.generation === generation,
          });
          accepted = Boolean(result);
        } finally {
          proj.replyPending = false;
        }
      }
      if (replyText !== null) {
        await sendReplyToFeishu(channel, chatId, replyText, { incomingMessageId: messageId, notice: true });
      }
      await drainQueue(pm, alias);
    } catch (e) {
      console.error('[ERROR] normalized message handler:', e);
      try {
        if (!mayReply) return;
        await sendReplyToFeishu(channel, msg.chatId, `（系统出错）${e?.message || String(e)}`, { incomingMessageId: msg.messageId, notice: true });
      } catch (sendError) {
        console.error('[ERROR] message error reply:', sendError);
      }
    } finally {
      if (reservedRecords && !accepted && pm.getProject(alias)?.generation === generation) {
        try { pm.groupMessages.restore(alias, reservedRecords); }
        catch (e) { console.error('[ERROR] group buffer persistence:', e); }
      }
    }
  };
}

// ─── Self-test ───────────────────────────────────────────────────

async function runSelfTest() {
  const ok = (name, cond) => {
    if (!cond) throw new Error(`Selftest failed: ${name}`);
    console.log(`[OK] ${name}`);
  };

  // 1) post with list-like text structure (simulate nested arrays)
  const postExample = {
    title: '标题',
    content: [
      [
        { tag: 'text', text: '1. item1' },
        { tag: 'text', text: '2. item2' },
      ],
      [
        { tag: 'a', text: 'link', href: 'https://example.com' },
      ],
    ],
  };

  const ex1 = extractFromPostJson(postExample);
  ok('post extract text not empty', ex1.text.includes('item1') && ex1.text.includes('link'));

  // 2) markdown local image path extraction
  const md = '看看这张图 ![x](/Users/me/.codes/media/a.png)';
  const paths = extractMarkdownLocalMediaPaths(md);
  ok('markdown local path parsed', paths.length === 1 && paths[0].includes('.codes/media/a.png'));
  ok('markdown local path stripped', stripMarkdownLocalMediaRefs(md).includes('[图片]'));

  // 3) MEDIA line parsing
  const r = parseMediaLines('hello\nMEDIA: /tmp/a.mp4\nworld');
  ok('MEDIA parsed', r.mediaUrls.length === 1 && r.text.includes('hello') && r.text.includes('world'));

  // 4) CodexAppServer construction
  const cp = new CodexAppServer({ workDir: '/tmp', codexPath: 'codex', threadId: 'test-123' });
  const info = cp.info();
  ok('CodexAppServer info', info.status === 'idle' && info.sessionId === 'test-123' && info.turnCount === 0);
  ok('CodexAppServer backend tag', info.backend === 'codex');

  // 5) interrupt returns false when not busy
  ok('interrupt when idle', cp.interrupt() === false);

  // Defaults must not override local Codex settings in thread/start or resume.
  const calls = [];
  cp._sessionId = null;
  cp._send = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'local-defaults-test' } };
  };
  await cp._ensureThread();
  ok('thread/start inherits local defaults', JSON.stringify(calls[0]) === JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp' } }));
  cp._threadReady = false;
  await cp._ensureThread();
  ok('thread/resume inherits local defaults', JSON.stringify(calls[1]) === JSON.stringify({ method: 'thread/resume', params: { threadId: 'local-defaults-test', excludeTurns: true } }));
  cp._threadReady = false;
  cp._sandbox = 'read-only';
  cp._approvalPolicy = 'on-request';
  await cp._ensureThread();
  ok('explicit thread overrides preserved', calls[2].params.sandbox === 'read-only' && calls[2].params.approvalPolicy === 'on-request');

  // Model and effort move together for /hard; /reset and /start restore defaults.
  const profileCalls = [];
  const profileAgent = new CodexAppServer({
    workDir: '/tmp', model: 'gpt-6.2-sol', reasoningEffort: 'xhigh',
  });
  profileAgent.start = async () => {};
  profileAgent._send = async (method, params) => {
    profileCalls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'profile-test' } };
    if (method === 'turn/start') return { turn: { id: 'turn-test' } };
    return { thread: { id: 'profile-test' } };
  };
  await profileAgent._ensureThread();
  ok('new thread uses default model and effort',
    profileCalls[0].params.model === 'gpt-6.2-sol'
    && profileCalls[0].params.config.model_reasoning_effort === 'xhigh');
  const profilePm = new ProjectManager({});
  profilePm._saveSessions = () => {};
  profilePm._projects.set('profile', { agent: profileAgent, started: true });
  await handleSlashCommand(profilePm, 'profile', '/hard');
  const hardTurn = profileAgent.sendMessage('hard task');
  await new Promise((resolve) => setImmediate(resolve));
  const hardParams = profileCalls.find((call) => call.method === 'turn/start')?.params;
  ok('/hard applies Astra and high on next turn',
    hardParams?.model === 'gpt-6.2-astra' && hardParams?.effort === 'high');
  profileAgent._finishTurn({ status: 'completed' });
  await hardTurn;
  await profilePm.resetProject('profile');
  await profileAgent._ensureThread();
  const resetParams = profileCalls.filter((call) => call.method === 'thread/start').at(-1)?.params;
  ok('/reset restores Sol and xhigh for a fresh thread',
    resetParams?.model === 'gpt-6.2-sol' && resetParams?.config.model_reasoning_effort === 'xhigh');
  await handleSlashCommand(profilePm, 'profile', '/hard');
  await profilePm.stopProject('profile');
  await profilePm.startProject('profile');
  ok('/start restores default profile',
    profileAgent.info().model === 'gpt-6.2-sol' && profileAgent.info().reasoningEffort === 'xhigh');

  // 6) pendingMessages single-slot queue
  pendingMessages.set('test', { text: 'a', chatId: 'c', channel: null, thresholdMs: 0 });
  pendingMessages.set('test', { text: 'b', chatId: 'c', channel: null, thresholdMs: 0 });
  ok('single-slot queue', pendingMessages.get('test').text === 'b');
  pendingMessages.delete('test');

  // 7) bridge config file check
  const cfgPath = resolvePath('~/.codes/bridge.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = loadBridgeConfig();
      ok('bridge.json valid', Object.keys(cfg.projects).length > 0);
    } catch (e) {
      console.log(`[SKIP] bridge.json validation failed: ${e?.message || String(e)}`);
    }
  } else {
    console.log('[SKIP] ~/.codes/bridge.json not found');
  }

  // 8) delayed-send command parsing
  const s1 = parseDelayedSendCommand('/2-30 两小时后同步');
  ok('delayed parse valid', s1 && !('error' in s1) && s1.hours === 2 && s1.minutes === 30 && s1.text === '两小时后同步');
  const s2 = parseDelayedSendCommand('/1000-10 hi');
  ok('delayed parse invalid hour', s2 && 'error' in s2);
  const s3 = parseDelayedSendCommand('/1-99 hi');
  ok('delayed parse invalid minute', s3 && 'error' in s3);
  const s4 = parseDelayedSendCommand('/0-0 hi');
  ok('delayed parse zero delay', s4 && 'error' in s4);
  const s5 = parseDelayedSendCommand('/2-30');
  ok('delayed parse empty body', s5 && 'error' in s5);
  ok('legacy clock schedule detected', isLegacyClockScheduleCommand('/09:30 hi') === true);

  // 9) delayed schedule time calculation
  const now1 = new Date('2026-03-05T08:10:20');
  const n1 = computeDelayScheduleTime(2, 30, now1);
  ok('delayed time +2h30m', formatLocalDateTime(n1).endsWith('10:40:20'));
  const now2 = new Date('2026-03-05T23:50:00');
  const n2 = computeDelayScheduleTime(0, 20, now2);
  ok('delayed time cross day', n2.getDate() !== now2.getDate() || n2.getMonth() !== now2.getMonth());

  // 10) markdown card detection
  ok('card: code block', shouldUseMarkdownCard('```js\nconsole.log(1);\n```') === true);
  ok('card: table', shouldUseMarkdownCard('| a | b |\n|---|---|\n| 1 | 2 |') === true);
  ok('card: bold', shouldUseMarkdownCard('text **bold** here') === true);
  ok('card: heading', shouldUseMarkdownCard('# Title\nsome text') === true);
  ok('card: bullet list', shouldUseMarkdownCard('- item one\n- item two') === true);
  ok('card: ordered list', shouldUseMarkdownCard('1. first\n2. second') === true);
  ok('card: plain text no card', shouldUseMarkdownCard('hello world') === false);
  ok('card: build structure', (() => {
    const card = buildMarkdownCard('test **bold**');
    return card.schema === '2.0' && card.body.elements[0].tag === 'markdown';
  })());

  // 11) SDK 1.66+ createLarkChannel availability
  ok('SDK createLarkChannel', typeof Lark.createLarkChannel === 'function');
  ok('SDK Domain.Feishu', Lark.Domain.Feishu !== undefined);
  ok('SDK AppType.SelfBuild', Lark.AppType.SelfBuild !== undefined);

  // Exercise the real SDK ingress: mocking normalized handlers skips its
  // process-global dedup cache and can hide cross-bot message loss.
  const sdkReceipts = [[], [], []];
  const sdkErrors = [];
  const sdkChannels = ['xiaobei', 'relay', 'codes'].map((name, i) => {
    const channel = createFeishuChannel(`selftest-${name}`, 'test-only');
    channel.botIdentity = { openId: `selftest-${name}-bot`, name };
    channel.safety.setBotIdentity(channel.botIdentity);
    channel.registerDispatcherHandlers();
    channel.on({
      message: (msg) => sdkReceipts[i].push(msg),
      error: (err) => sdkErrors.push(err),
    });
    return channel;
  });
  try {
    const sdkMessage = (id, text, mentioned = null) => ({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: id },
      event: {
        sender: { sender_id: { open_id: 'selftest-user' }, sender_type: 'user' },
        message: {
          message_id: id, chat_id: 'shared-sdk-group', chat_type: 'group',
          message_type: 'text', create_time: String(Date.now()), content: JSON.stringify({ text }),
          mentions: mentioned ? [{ key: '@_user_1', id: { open_id: mentioned }, name: 'test bot' }] : [],
        },
      },
    });
    const deliverViaSdk = async (event) => {
      // The first bot completes before the others receive the same event,
      // reproducing the observed arrival order instead of masking the race.
      for (const channel of sdkChannels) {
        await channel.dispatcher.invoke(event);
        await new Promise(setImmediate);
      }
    };
    const sdkPrefix = crypto.randomUUID();
    const sharedEvent = sdkMessage(`${sdkPrefix}-background`, '共同讨论');
    await deliverViaSdk(sharedEvent);
    ok('SDK delivers the same group message to every bot', sdkReceipts.every((messages) => messages.length === 1));
    await deliverViaSdk(sdkMessage(`${sdkPrefix}-relay`, '@_user_1 请检查 relay', 'selftest-relay-bot'));
    await deliverViaSdk(sdkMessage(`${sdkPrefix}-codes`, '@_user_1 请检查 codes', 'selftest-codes-bot'));
    ok('SDK preserves each bot mention after another bot receives the event first',
      sdkReceipts.every((messages) => messages.length === 3)
      && sdkReceipts[1][1].mentionedBot && !sdkReceipts[0][1].mentionedBot
      && sdkReceipts[2][2].mentionedBot && !sdkReceipts[1][2].mentionedBot);
    await deliverViaSdk(sdkMessage(`${sdkPrefix}-slash`, '/status'));
    ok('SDK delivers unmentioned Slash commands to every bot', sdkReceipts.every((messages) => messages.length === 4));
    await deliverViaSdk(sdkMessage(`${sdkPrefix}-all`, '@_all 大家看一下'));
    ok('SDK passes @all messages for accumulation without mentioning a bot',
      sdkReceipts.every((messages) => messages.length === 5 && messages[4].mentionAll && !messages[4].mentionedBot));
    await deliverViaSdk(sharedEvent);
    ok('SDK still deduplicates redelivery within each bot', sdkReceipts.every((messages) => messages.length === 5));
    ok('SDK ingress has no normalization errors', sdkErrors.length === 0);
  } finally {
    await Promise.all(sdkChannels.map((channel) => channel.disconnect()));
  }

  // 12) buildMarkdownCard with options
  const cardWithStop = buildMarkdownCard('test', { showStopButton: true, streaming: true, summary: 'thinking' });
  ok('card with stop button', cardWithStop.body.elements.length === 2 && cardWithStop.body.elements[1].tag === 'action');
  ok('card streaming mode', cardWithStop.config.streaming_mode === true);
  ok('card summary', cardWithStop.config.summary.content === 'thinking');

  // Exercise real message dispatch and streaming with a fake channel: no API calls.
  const conversationConfig = {
    projects: {
      relay: { path: '/tmp', feishu: { appId: 'selftest-bot', appSecretPath: '/secret' }, codex: { model: 'relay-model' } },
      'xiaobei-dev': { path: '/tmp/xiaobei', feishu: { appId: 'xiaobei-bot', appSecretPath: '/xiaobei-secret' }, codex: { model: 'xiaobei-model' } },
    }, codexDefaults: { reasoningEffort: 'high' },
  };
  const conversationPm = new ProjectManager(conversationConfig);
  conversationPm._saveSessions = () => {};
  conversationPm._restoreProjects({ relay: { sessionId: 'legacy-private-thread' } });
  const privateChat = conversationPm.getConversation('relay', 'p2p', 'private-1');
  const otherPrivate = conversationPm.getConversation('relay', 'p2p', 'private-2');
  const groupChat = conversationPm.getConversation('relay', 'group', 'group-1');
  const otherGroup = conversationPm.getConversation('relay', 'group', 'group-2');
  const xiaobeiGroup = conversationPm.getConversation('xiaobei-dev', 'group', 'group-1');
  ok('private legacy session preserved', privateChat.project.agent.info().sessionId === 'legacy-private-thread');
  ok('conversations use independent Codex instances',
    new Set([privateChat, otherPrivate, groupChat, otherGroup, xiaobeiGroup].map((c) => c.project.agent)).size === 5);
  ok('private and group channels inherit the same project configuration',
    groupChat.project.projectAlias === 'relay' && groupChat.alias === 'relay:group:group-1'
    && privateChat.project.agent.info().model === 'relay-model' && groupChat.project.agent.info().model === 'relay-model'
    && groupChat.project.path === privateChat.project.path && groupChat.project.agent.info().sessionId === null);
  ok('bots in the same group retain their own project configuration',
    xiaobeiGroup.project.projectAlias === 'xiaobei-dev' && xiaobeiGroup.project.path === '/tmp/xiaobei'
    && xiaobeiGroup.project.agent.info().model === 'xiaobei-model' && xiaobeiGroup.project.agent !== groupChat.project.agent);
  const snapshot = Object.fromEntries([...conversationPm._projects].map(([key, project]) => [key, {
    sessionId: `${key}-thread`, projectAlias: project.projectAlias, chatType: project.chatType, chatId: project.chatId,
  }]));
  const restoredPm = new ProjectManager(conversationConfig);
  restoredPm._saveSessions = () => {};
  restoredPm._restoreProjects(snapshot);
  ok('conversation bindings restored after restart',
    restoredPm.getConversation('relay', 'p2p', 'private-1').project.agent.info().sessionId === 'relay-thread'
    && restoredPm.getConversation('relay', 'group', 'group-2').project.agent.info().sessionId === `${otherGroup.alias}-thread`
    && restoredPm.getConversation('xiaobei-dev', 'group', 'group-1').project.agent.info().sessionId === `${xiaobeiGroup.alias}-thread`);
  const legacyScheduled = await resolveScheduledConversation(conversationPm, 'relay', { chatId: 'group-1' }, {
    async getChatMode() { return 'group'; },
  });
  const privateScheduled = await resolveScheduledConversation(conversationPm, 'relay', { chatId: 'private-2', chatType: 'p2p' }, {});
  ok('scheduled messages restore into the same project and correct chat session',
    legacyScheduled?.alias === groupChat.alias && privateScheduled?.alias === otherPrivate.alias);

  const sends = [];
  const turns = [];
  const controller = () => ({
    content: '', sequence: 0, streamingFailed: false, rolloverMessageIds: [], maxChars: 30000,
    async setContent(value) { this.content = value; this.sequence++; },
  });
  const fakeChannel = {
    botIdentity: { openId: 'selftest-bot-id' },
    rawClient: {},
    async send(chatId, input) { sends.push({ chatId, input }); return {}; },
    async stream(chatId, input) { sends.push({ chatId, stream: true }); await input.markdown(controller()); return {}; },
  };
  for (const conversation of [privateChat, otherPrivate, groupChat, otherGroup, xiaobeiGroup]) {
    conversation.project.agent.sendMessage = async (text) => {
      turns.push({ alias: conversation.alias, text });
      return { text: '处理完成' };
    };
  }
  let messageNo = 0;
  const message = (content, options = {}) => ({
    chatId: 'group-1', chatType: 'group', messageId: `group-selftest-${++messageNo}`,
    senderId: 'sender-a', senderName: '张三', createTime: 1000 + messageNo,
    content, resources: [], mentions: [], mentionedBot: false, ...options,
  });
  const groupHandler = createNormalizedMessageHandler(conversationPm, 'relay', fakeChannel, 0);
  const privateHandler = createNormalizedMessageHandler(conversationPm, 'relay', fakeChannel, 0);
  const passive = message('请帮我排查？', { mentions: [{ openId: 'another-user' }] });
  await groupHandler(passive);
  await groupHandler(passive);
  await groupHandler(message('第二条背景'));
  await groupHandler(message('所有人看一下', { mentionAll: true }));
  await groupHandler(message('', { resources: [{ type: 'image', fileKey: 'image-1' }] }));
  await groupHandler(message('机器人自己的回复', { senderId: 'selftest-bot-id' }));
  ok('unmentioned ordinary group messages only accumulate, including media',
    sends.length === 0 && turns.length === 0 && conversationPm.groupMessages.count(groupChat.alias) === 4);
  await groupHandler(message('另一群的背景', { chatId: 'group-2' }));
  await groupHandler(message('归纳这些消息', { mentionedBot: true }));
  const firstGroupTurn = turns.at(-1);
  ok('@ request includes ordered background and sender identity',
    firstGroupTurn.text.includes('张三 (sender-a)')
    && firstGroupTurn.text.indexOf('请帮我排查？') < firstGroupTurn.text.indexOf('第二条背景')
    && firstGroupTurn.text.includes('image-1') && firstGroupTurn.text.includes('归纳这些消息'));
  ok('@ request clears only the current group batch',
    conversationPm.groupMessages.count(groupChat.alias) === 0
    && conversationPm.groupMessages.count(otherGroup.alias) === 1
    && !firstGroupTurn.text.includes('另一群的背景'));
  await privateHandler(message('私聊内容', { chatType: 'p2p', chatId: 'private-1' }));
  ok('private request excludes group background', turns.at(-1).text === '私聊内容' && turns.at(-1).alias === 'relay');
  await groupHandler(message('新的群聊背景'));
  const sendsBeforeStatus = sends.length;
  const turnsBeforeStatus = turns.length;
  await groupHandler(message('/status'));
  ok('unmentioned Slash command executes immediately and preserves background',
    sends.length === sendsBeforeStatus + 1 && turns.length === turnsBeforeStatus
    && conversationPm.groupMessages.count(groupChat.alias) === 1);
  await groupHandler(message('/model group-updated'));
  await groupHandler(message('/hard'));
  await groupHandler(message('/cost'));
  await groupHandler(message('/context'));
  await groupHandler(message('/help'));
  ok('group Slash commands use their existing handlers without @',
    groupChat.project.agent.info().model === 'gpt-6.2-astra'
    && privateChat.project.agent.info().model === 'relay-model'
    && conversationPm.groupMessages.count(groupChat.alias) === 1);
  await groupHandler(message('/custom-task-without-mention'));
  ok('unknown Slash command passes directly to AI without consuming background',
    turns.at(-1).text === '/custom-task-without-mention'
    && conversationPm.groupMessages.count(groupChat.alias) === 1);
  await groupHandler(message('/custom-task', { mentionedBot: true }));
  ok('unknown slash command receives group background',
    turns.at(-1).text.includes('新的群聊背景') && turns.at(-1).text.includes('/custom-task'));

  const steered = [];
  groupChat.project.agent._status = 'busy';
  groupChat.project.agent.steer = async (text) => { steered.push(text); return { ok: true }; };
  await groupHandler(message('正在处理时的背景'));
  await groupHandler(message('追加请求', { mentionedBot: true }));
  ok('steering includes and consumes group background',
    steered[0]?.includes('正在处理时的背景') && steered[0]?.includes('追加请求')
    && conversationPm.groupMessages.count(groupChat.alias) === 0 && !pendingMessages.has(groupChat.alias));
  await privateHandler(message('群聊忙碌时的私聊', { chatType: 'p2p', chatId: 'private-1' }));
  ok('busy group does not block private chat', turns.at(-1).text === '群聊忙碌时的私聊');
  groupChat.project.agent._status = 'idle';

  // A card can take time to start. Concurrent @ requests must queue rather
  // than start a second turn before sendMessage() has claimed busy.
  let releaseStream;
  let firstStream = true;
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  const slowChannel = { ...fakeChannel, async stream(chatId, input) {
    if (firstStream) { firstStream = false; await streamGate; }
    return fakeChannel.stream(chatId, input);
  } };
  const concurrentHandler = createNormalizedMessageHandler(conversationPm, 'relay', slowChannel, 0);
  const turnCountBefore = turns.length;
  const activeReply = concurrentHandler(message('第一轮请求', { mentionedBot: true }));
  await concurrentHandler(message('第二批背景'));
  await concurrentHandler(message('第二轮请求', { mentionedBot: true }));
  await concurrentHandler(message('第三批背景'));
  await concurrentHandler(message('第三轮请求', { mentionedBot: true }));
  ok('busy group requests merge without dropping earlier batches',
    pendingMessages.get(groupChat.alias)?.text.includes('第二批背景')
    && pendingMessages.get(groupChat.alias)?.text.includes('第二轮请求')
    && pendingMessages.get(groupChat.alias)?.text.includes('第三批背景')
    && pendingMessages.get(groupChat.alias)?.text.includes('第三轮请求'));
  await concurrentHandler(message('留给下一次的背景'));
  releaseStream();
  await activeReply;
  ok('queued group requests drain after current turn', turns.length === turnCountBefore + 2 && !pendingMessages.has(groupChat.alias));
  ok('messages arriving during processing remain for the next @', conversationPm.groupMessages.count(groupChat.alias) === 1);

  groupChat.project.agent.stop = async () => {};
  groupChat.project.agent._sessionId = 'group-before-reset';
  await groupHandler(message('/reset'));
  ok('unmentioned group reset clears unsent background and resets only this session',
    conversationPm.groupMessages.count(groupChat.alias) === 0
    && groupChat.project.agent.info().sessionId === null
    && conversationPm.groupMessages.count(otherGroup.alias) === 1
    && privateChat.project.agent.info().sessionId === 'legacy-private-thread');
  await groupHandler(message('clear 之前积累的背景'));
  queuePendingMessage(conversationPm, groupChat.alias, { text: '待处理的群聊请求' });
  groupChat.project.agent._sessionId = 'group-before-clear';
  await groupHandler(message('/clear'));
  ok('unmentioned group clear resets the session and clears unsent background and queue',
    groupChat.project.agent.info().sessionId === null
    && conversationPm.groupMessages.count(groupChat.alias) === 0
    && !pendingMessages.has(groupChat.alias)
    && conversationPm.groupMessages.count(otherGroup.alias) === 1);
  await groupHandler(message('暂停前未发送的背景'));
  await groupHandler(message('/stop'));
  ok('unmentioned group stop preserves accumulated background',
    !groupChat.project.started && conversationPm.groupMessages.count(groupChat.alias) === 1);
  await groupHandler(message('/clear'));
  ok('unmentioned clear also discards background when the group session is stopped',
    groupChat.project.started && conversationPm.groupMessages.count(groupChat.alias) === 0);
  await groupHandler(message('/stop'));
  await groupHandler(message('/start'));
  ok('unmentioned group start and stop stay isolated from private chat',
    groupChat.project.started && privateChat.project.started);

  let releaseCancelledStream;
  const cancelledGate = new Promise((resolve) => { releaseCancelledStream = resolve; });
  const cancelledChannel = { ...fakeChannel, async stream(chatId, input) {
    await cancelledGate;
    return fakeChannel.stream(chatId, input);
  } };
  const turnsBeforeReset = turns.length;
  const cancelledRequest = createNormalizedMessageHandler(conversationPm, 'relay', cancelledChannel, 0)(message('重置前的请求', { mentionedBot: true }));
  await groupHandler(message('/reset'));
  releaseCancelledStream();
  await cancelledRequest;
  ok('reset during card creation cancels the old request and does not restore its buffer',
    turns.length === turnsBeforeReset && conversationPm.groupMessages.count(groupChat.alias) === 0);

  groupChat.project.started = false;
  await groupHandler(message('暂停期间的请求', { mentionedBot: true }));
  ok('stopped group retains pending context', conversationPm.groupMessages.count(groupChat.alias) === 1);
  groupChat.project.started = true;
  const failingChannel = { ...fakeChannel, async stream() { throw new Error('selftest card failure'); } };
  groupChat.project.agent.sendMessage = async () => { throw new Error('selftest turn failure'); };
  await createNormalizedMessageHandler(conversationPm, 'relay', failingChannel, 0)(message('失败的请求', { mentionedBot: true }));
  ok('failed AI submission restores its group batch', conversationPm.groupMessages.count(groupChat.alias) === 2);

  // The same group message is independently delivered to both project bots.
  // Mentioning one bot must neither trigger nor consume the other's context.
  const sharedRelay = conversationPm.getConversation('relay', 'group', 'shared-room');
  const sharedXiaobei = conversationPm.getConversation('xiaobei-dev', 'group', 'shared-room');
  for (const conversation of [sharedRelay, sharedXiaobei]) {
    conversation.project.agent.stop = async () => {};
    conversation.project.agent.sendMessage = async (text) => {
      turns.push({ alias: conversation.alias, text });
      return { text: '处理完成' };
    };
  }
  const xiaobeiChannel = { ...fakeChannel, botIdentity: { openId: 'xiaobei-bot-id' } };
  const xiaobeiHandler = createNormalizedMessageHandler(conversationPm, 'xiaobei-dev', xiaobeiChannel, 0);
  const deliverToBoth = (msg) => Promise.all([groupHandler(msg), xiaobeiHandler(msg)]);
  await deliverToBoth(message('共同讨论的内容', { chatId: 'shared-room' }));
  ok('both project bots accumulate the same group message independently',
    conversationPm.groupMessages.count(sharedRelay.alias) === 1
    && conversationPm.groupMessages.count(sharedXiaobei.alias) === 1);
  const turnsBeforeXiaobei = turns.length;
  await deliverToBoth(message('请检查小贝开发', {
    chatId: 'shared-room', mentions: [{ openId: 'xiaobei-bot-id' }],
  }));
  ok('@ xiaobei triggers only its project and leaves relay background intact',
    turns.length === turnsBeforeXiaobei + 1 && turns.at(-1).alias === sharedXiaobei.alias
    && turns.at(-1).text.includes('共同讨论的内容')
    && conversationPm.groupMessages.count(sharedXiaobei.alias) === 0
    && conversationPm.groupMessages.count(sharedRelay.alias) === 2);
  const turnsBeforeRelay = turns.length;
  await deliverToBoth(message('请检查 relay 运维', {
    chatId: 'shared-room', mentions: [{ openId: 'selftest-bot-id' }],
  }));
  ok('@ relay uses its own project and accumulated group context',
    turns.length === turnsBeforeRelay + 1 && turns.at(-1).alias === sharedRelay.alias
    && turns.at(-1).text.includes('共同讨论的内容') && turns.at(-1).text.includes('请检查小贝开发')
    && conversationPm.groupMessages.count(sharedRelay.alias) === 0
    && conversationPm.groupMessages.count(sharedXiaobei.alias) === 1);
  await groupHandler(message('/model shared-relay-model relay', { chatId: 'shared-room' }));
  ok('commands naming this project operate on its current group channel',
    sharedRelay.project.agent.info().model === 'shared-relay-model'
    && privateChat.project.agent.info().model === 'relay-model'
    && sharedXiaobei.project.agent.info().model === 'xiaobei-model');
  await deliverToBoth(message('清空前的共同背景', { chatId: 'shared-room' }));
  await deliverToBoth(message('/clear', { chatId: 'shared-room' }));
  ok('unmentioned clear resets each receiving bot in this group independently',
    conversationPm.groupMessages.count(sharedRelay.alias) === 0
    && conversationPm.groupMessages.count(sharedXiaobei.alias) === 0
    && conversationPm.groupMessages.count(groupChat.alias) === 2
    && privateChat.project.agent.info().sessionId === 'legacy-private-thread');

  // Deliver the reset replies back to both bots before the send API returns.
  // This reproduces /clear immediately refilling each bot's background with
  // the other bot's acknowledgement, including cross-app sender-ID differences.
  const noticeHandlers = [];
  const noticeChannels = [fakeChannel, xiaobeiChannel].map((base, senderIndex) => ({
    ...base, bridgeNotices: conversationPm.notices,
    async send(chatId, input) {
      const text = input.text || input.card.body.elements[0].content;
      const outgoing = message(text, { chatId, raw: { sender: { sender_type: 'app' } } });
      for (let recipientIndex = 0; recipientIndex < noticeHandlers.length; recipientIndex++) {
        await noticeHandlers[recipientIndex]({ ...outgoing,
          senderId: recipientIndex === senderIndex ? base.botIdentity.openId : `other-bot-as-seen-by-${recipientIndex}`,
        });
      }
      return { messageId: outgoing.messageId };
    },
  }));
  noticeHandlers.push(
    createNormalizedMessageHandler(conversationPm, 'relay', noticeChannels[0], 0),
    createNormalizedMessageHandler(conversationPm, 'xiaobei-dev', noticeChannels[1], 0),
  );
  const clearEvent = message('/clear', { chatId: 'shared-room' });
  await Promise.all(noticeHandlers.map((handler) => handler(clearEvent)));
  ok('group clear acknowledgements do not refill other bots background',
    conversationPm.groupMessages.count(sharedRelay.alias) === 0
    && conversationPm.groupMessages.count(sharedXiaobei.alias) === 0);
  await sendReplyToFeishu(noticeChannels[0], 'shared-room', '**模型状态**\n当前模型已切换', { notice: true });
  ok('control replies rendered as cards are excluded from group background',
    conversationPm.groupMessages.count(sharedXiaobei.alias) === 0);
  await sendReplyToFeishu(noticeChannels[0], 'shared-room', 'AI 分析后的实质性结论');
  ok('other bots AI conclusions remain group background',
    conversationPm.groupMessages.count(sharedXiaobei.alias) === 1
    && conversationPm.groupMessages.messages.get(sharedXiaobei.alias)[0].content === 'AI 分析后的实质性结论');
  await noticeHandlers[1](message(`${sharedRelay.alias} 会话已重置，下次对话将开始新会话（gpt-6.2-sol + xhigh）`, {
    chatId: 'shared-room', raw: { sender: { sender_type: 'user' } },
  }));
  ok('user quotes of control replies are preserved', conversationPm.groupMessages.count(sharedXiaobei.alias) === 2);

  const privateOnlyConfig = {
    ...conversationConfig,
    projects: {
      ...conversationConfig.projects,
      codes: { path: '/tmp', feishu: { appId: 'private-only-bot', allowGroupChats: false } },
    },
  };
  const privateOnlyPm = new ProjectManager(privateOnlyConfig);
  privateOnlyPm._saveSessions = () => {};
  const disabledGroup = conversationKey('codes', 'group', 'group-1');
  privateOnlyPm._restoreProjects({
    ...snapshot,
    codes: { sessionId: 'codes-private-thread', chatType: 'p2p', chatId: 'codes-private' },
    [disabledGroup]: { projectAlias: 'codes', chatType: 'group', chatId: 'group-1', sessionId: 'codes-group-thread' },
  });
  ok('disabling group chats removes saved group bindings and preserves private and other bots sessions',
    !privateOnlyPm.getProject(disabledGroup)
    && privateOnlyPm.getProject('codes').agent.info().sessionId === 'codes-private-thread'
    && privateOnlyPm.getProject(groupChat.alias).agent.info().sessionId === `${groupChat.alias}-thread`);
  privateOnlyPm.groupMessages.append(disabledGroup, groupMessageRecord(message('旧群背景')));
  privateOnlyPm.groupMessages.append(groupChat.alias, groupMessageRecord(message('保留其他 bot 背景')));
  privateOnlyPm._clearDisabledGroupMessages();
  ok('disabling group chats clears only that projects buffered group messages',
    !privateOnlyPm.groupMessages.messages.has(disabledGroup)
    && privateOnlyPm.groupMessages.count(groupChat.alias) === 1);
  const privateOnlySends = [];
  const privateOnlyTurns = [];
  const privateOnlyChannel = {
    ...fakeChannel,
    async send(chatId, input) { privateOnlySends.push({ chatId, input }); return {}; },
    async stream(chatId, input) { privateOnlySends.push({ chatId }); await input.markdown(controller()); return {}; },
  };
  const privateOnlyHandler = createNormalizedMessageHandler(privateOnlyPm, 'codes', privateOnlyChannel, 0);
  for (const incoming of [message('背景'), message('@ 你', { mentionedBot: true }), message('/clear')]) {
    await privateOnlyHandler(incoming);
  }
  ok('disabled group input cannot recreate a session, accumulate messages, or send command replies',
    !privateOnlyPm.getProject(disabledGroup) && privateOnlySends.length === 0
    && privateOnlyPm.groupMessages.count(disabledGroup) === 0
    && privateOnlyPm.getProject('codes').agent.info().sessionId === 'codes-private-thread');
  privateOnlyPm.getProject('codes').agent.sendMessage = async (text) => {
    privateOnlyTurns.push(text);
    return { text: '私聊正常' };
  };
  await privateOnlyHandler(message('私聊请求', { chatType: 'p2p', chatId: 'codes-private' }));
  ok('private conversations still work when group chats are disabled',
    privateOnlyTurns[0] === '私聊请求' && privateOnlySends.length === 1);
  ok('cross-project commands and schedules cannot recreate a disabled group or target its private session',
    privateOnlyPm.resolveTarget(groupChat.alias, 'codes') === disabledGroup
    && !privateOnlyPm.getProject(disabledGroup)
    && await resolveScheduledConversation(privateOnlyPm, 'codes', { chatId: 'group-1', chatType: 'group' }, {}) === null);

  // Retired groups must stay removed even if the old process saves them on exit.
  const retiredPm = new ProjectManager({ ...conversationConfig, disabledGroupChats: ['group-1'] });
  retiredPm._saveSessions = () => {};
  retiredPm._restoreProjects(snapshot);
  ok('retired groups are excluded for every bot while private and other groups restore',
    !retiredPm.getProject(groupChat.alias) && !retiredPm.getProject(xiaobeiGroup.alias)
    && retiredPm.getProject('relay').agent.info().sessionId === 'relay-thread'
    && retiredPm.getProject(otherGroup.alias).agent.info().sessionId === `${otherGroup.alias}-thread`);
  for (const conversation of [groupChat, xiaobeiGroup, otherGroup]) {
    retiredPm.groupMessages.append(conversation.alias, groupMessageRecord(message('遗留背景')));
  }
  retiredPm._clearDisabledGroupMessages();
  ok('retired group buffers are removed across bots without clearing active groups',
    retiredPm.groupMessages.count(groupChat.alias) === 0
    && retiredPm.groupMessages.count(xiaobeiGroup.alias) === 0
    && retiredPm.groupMessages.count(otherGroup.alias) === 1);
  const sendsBeforeRetiredInput = privateOnlySends.length;
  for (const projectAlias of ['relay', 'xiaobei-dev']) {
    const retiredHandler = createNormalizedMessageHandler(retiredPm, projectAlias, privateOnlyChannel, 0);
    for (const incoming of [message('背景'), message('@ 你', { mentionedBot: true }), message('/start')]) {
      await retiredHandler(incoming);
    }
  }
  ok('retired group input cannot recreate sessions, buffer messages, or send replies',
    !retiredPm.getProject(groupChat.alias) && !retiredPm.getProject(xiaobeiGroup.alias)
    && retiredPm.groupMessages.count(groupChat.alias) === 0
    && retiredPm.groupMessages.count(xiaobeiGroup.alias) === 0
    && privateOnlySends.length === sendsBeforeRetiredInput);
  ok('schedules cannot recreate retired groups, including legacy jobs without chat type',
    await resolveScheduledConversation(retiredPm, 'relay', { chatId: 'group-1', chatType: 'group' }, {}) === null
    && await resolveScheduledConversation(retiredPm, 'xiaobei-dev', { chatId: 'group-1' }, {
      async getChatMode() { return 'group'; },
    }) === null);

  console.log('[OK] Selftests finished');
}

// ─── Start ───────────────────────────────────────────────────────

if (SELFTEST) {
  await runSelfTest();
  process.exit(0);
}

const bridgeConfig = loadBridgeConfig();
if (bridgeConfig.debug) DEBUG = true;

// Codex CLI version check
try {
  const verOut = execFileSync(bridgeConfig.codexPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const match = verOut.match(/(\d+\.\d+\.\d+)/);
  if (match && match[1] !== EXPECTED_CODEX_VERSION) {
    console.warn(`[WARN] Codex version ${match[1]} (expected ${EXPECTED_CODEX_VERSION}). app-server protocol churns fast; compatibility not guaranteed.`);
  } else if (match) {
    console.log(`[OK] Codex v${match[1]}`);
  } else {
    console.warn(`[WARN] Could not parse Codex version: ${verOut}`);
  }
} catch (e) {
  console.error(`[ERROR] Cannot find codex CLI at "${bridgeConfig.codexPath}": ${e.message}`);
  if (!SELFTEST) process.exit(1);
}

// Codex loads its own config, credentials, skills and memories.

const pm = new ProjectManager(bridgeConfig);
await pm.init();

// Each project's bot receives both private and group messages.
channelMap = new Map();  // alias → LarkChannel
const botProjects = indexBotProjects(bridgeConfig.projects);
for (const [appId, { alias, project: proj }] of botProjects) {
  const secret = mustRead(proj.feishu.appSecretPath, `Feishu secret for "${alias}"`);

  const channel = createFeishuChannel(appId, secret, pm.notices);

  channel.on({
    message: (msg) => {
      void createNormalizedMessageHandler(pm, alias, channel, bridgeConfig.thinkingThresholdMs)(msg);
    },
    cardAction: (evt) => {
      const conversation = [...pm._projects.entries()].find(([, instance]) =>
        instance.feishuAppId === appId && instance.chatId === evt.chatId);
      if (conversation) handleCardAction(pm, conversation[0], evt);
    },
    reconnecting: () => console.log(`[WS] "${alias}" reconnecting...`),
    reconnected: () => console.log(`[WS] "${alias}" reconnected`),
    error: (err) => console.error(`[WS] "${alias}" error:`, err?.message || String(err)),
  });

  try {
    // channel.connect() has a WebSocket handshake timeout, but its initial
    // bot-identity/token HTTP calls use the SDK default axios instance with
    // timeout=0. A stale TUN route can therefore leave startup hanging forever.
    await withTimeout(channel.connect(), 30_000, `Feishu channel "${alias}" connect timeout after 30000ms`);
  } catch (e) {
    console.error(`[FATAL] Failed to connect Feishu bot "${alias}": ${e?.message || String(e)}`);
    throw e;
  }
  channelMap.set(alias, channel);

  const botId = channel.botIdentity?.openId || '?';
  console.log(`[OK] Bot started: "${alias}" (appId=${appId}, path=${proj.path}, botOpenId=${botId})`);
}

await restoreScheduledMessages(pm, channelMap, bridgeConfig.thinkingThresholdMs);

console.log(`[OK] Feishu bridge v${BRIDGE_VERSION} started — ${Object.keys(bridgeConfig.projects).length} project(s)`);
console.log(`[OK] Allowed local media dirs: ${ALLOWED_LOCAL_MEDIA_DIRS.join(', ') || '(none)'}`);
