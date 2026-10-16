// Cloudflare Worker + Static Assets (Web standard Request/Response).
// Tanpa dependency: pakai fetch/Response/TransformStream bawaan runtime Workers.
// Route: /api/models, /api/chat, /health. Selain itu dilayani dari folder public/ (binding ASSETS).

const ANTHROPIC_VERSION = '2023-06-01';
const DETECT_TIMEOUT_MS = 6000;
const STYLE_CACHE_TTL_MS = 30 * 60 * 1000;

// Env Cloudflare datang per-request lewat context.env (bukan process.env).
function getCfg(env = {}) {
  return {
    DEFAULT_BASE_URL: String(env.DEFAULT_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    DEFAULT_API_KEY: env.DEFAULT_API_KEY ?? '',
    DEFAULT_KEY_DAILY_LIMIT: Number(env.DEFAULT_KEY_DAILY_LIMIT ?? '200')
  };
}

// Dihitung di memori per isolate -> hanya perkiraan kasar (sama seperti versi Netlify).
let defaultKeyUsage = { day: '', count: 0 };
function defaultKeyQuotaOk(cfg) {
  if (!cfg.DEFAULT_KEY_DAILY_LIMIT) return true;
  const today = new Date().toISOString().slice(0, 10);
  if (defaultKeyUsage.day !== today) defaultKeyUsage = { day: today, count: 0 };
  if (defaultKeyUsage.count >= cfg.DEFAULT_KEY_DAILY_LIMIT) return false;
  defaultKeyUsage.count += 1;
  return true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });

// ----------------------------- Util -----------------------------

function normalizeBase(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function getBaseUrl(req, url, body, cfg) {
  return normalizeBase(
    req.headers.get('x-provider-base-url') || url.searchParams.get('baseUrl') || body?.baseUrl || cfg.DEFAULT_BASE_URL
  );
}

function resolveApiKey(req, url, body, cfg) {
  const explicit = req.headers.get('x-provider-key') || url.searchParams.get('apikey') || body?.apikey || '';
  if (explicit) return { apiKey: explicit, quotaExceeded: false };
  if (!cfg.DEFAULT_API_KEY || !cfg.DEFAULT_BASE_URL) return { apiKey: '', quotaExceeded: false };
  if (getBaseUrl(req, url, body, cfg) !== cfg.DEFAULT_BASE_URL) return { apiKey: '', quotaExceeded: false };
  if (!defaultKeyQuotaOk(cfg)) return { apiKey: '', quotaExceeded: true };
  return { apiKey: cfg.DEFAULT_API_KEY, quotaExceeded: false };
}

function keyError({ quotaExceeded }) {
  return json(
    {
      error: quotaExceeded
        ? 'Kuota gratis (kunci bawaan) hari ini sudah habis. Silakan isi API key kamu sendiri di Pengaturan.'
        : 'API key wajib diisi.'
    },
    400
  );
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelList(rawModels) {
  return rawModels
    .map((m) => ({
      id: m.id || m.name || m.model,
      owned_by: m.owned_by || m.owner || null,
      context_window: m.context_window || m.context_length || null,
      active: m.active !== undefined ? m.active : true
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ----------------------------- Deteksi gaya API -----------------------------

const styleCache = new Map();
const cacheKey = (b, k) => `${b}::${k}`;
function getCachedDetection(b, k) {
  const e = styleCache.get(cacheKey(b, k));
  if (!e) return null;
  if (Date.now() - e.ts > STYLE_CACHE_TTL_MS) {
    styleCache.delete(cacheKey(b, k));
    return null;
  }
  return e;
}
const setCachedDetection = (b, k, d) => styleCache.set(cacheKey(b, k), { ...d, ts: Date.now() });

const looksLikeClaudeModel = (m) => /claude/i.test(String(m || ''));

function pickStyleForModel(detection, model) {
  const o = !!detection.openai?.ok;
  const a = !!detection.anthropic?.ok;
  if (o && a) return looksLikeClaudeModel(model) ? 'anthropic' : 'openai';
  if (o) return 'openai';
  if (a) return 'anthropic';
  return null;
}

async function probeModels(style, baseUrl, apiKey) {
  const headers =
    style === 'openai'
      ? { Authorization: `Bearer ${apiKey}` }
      : { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  const res = await fetchWithTimeout(`${baseUrl}/models`, { headers }, DETECT_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${style}:${res.status}:${text.slice(0, 200)}`);
  }
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${style}:non-json:${raw.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const models = normalizeModelList(rawModels);
  if (!models.length) throw new Error(`${style}:empty`);
  return { style, models };
}

async function detectProviderFast(baseUrl, apiKey) {
  const [o, a] = await Promise.allSettled([
    probeModels('openai', baseUrl, apiKey),
    probeModels('anthropic', baseUrl, apiKey)
  ]);
  const detection = {
    openai: o.status === 'fulfilled' ? { ok: true, models: o.value.models } : null,
    anthropic: a.status === 'fulfilled' ? { ok: true, models: a.value.models } : null
  };
  if (!detection.openai && !detection.anthropic) {
    const detail = [o.reason, a.reason].map((e) => e?.message || String(e)).join(' | ');
    throw new Error(
      detail.includes('401') || detail.includes('403')
        ? 'API key ditolak provider (401/403). Cek lagi API key-nya.'
        : detail.includes('404')
        ? 'Endpoint /models tidak ditemukan di domain ini. Cek lagi base URL-nya.'
        : detail.includes('non-json')
        ? `Domain ini membalas dengan HTML/halaman biasa, bukan data model (JSON), waktu dicoba di "${baseUrl}/models". Ini biasanya berarti base URL-nya kurang tepat atau domain ini bukan endpoint API OpenAI/Anthropic-compatible. Cek lagi dokumentasi API provider ini untuk base URL yang benar.`
        : `Tidak berhasil terhubung ke provider. Detail: ${detail || 'tidak ada respons'}`
    );
  }
  const merged = [...(detection.openai?.models || []), ...(detection.anthropic?.models || [])];
  const models = Array.from(new Map(merged.map((m) => [m.id, m])).values()).sort((x, y) =>
    x.id.localeCompare(y.id)
  );
  return { style: detection.openai ? 'openai' : 'anthropic', models, detection };
}

// ----------------------------- Chat -----------------------------

const LANGUAGE_SYSTEM_PROMPT =
  'Selalu balas dalam bahasa yang sama persis dengan bahasa yang dipakai user di pesan terakhirnya. ' +
  'Jika user menulis dalam Bahasa Indonesia, balas 100% dalam Bahasa Indonesia (jangan campur bahasa lain, ' +
  'jangan pakai Bahasa Arab kecuali user memakainya). Jangan minta izin atau konfirmasi soal bahasa, langsung jawab.';

function bodyHasImageContent(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p && (p.type === 'image_url' || p.type === 'image'))
  );
}

function maybeFriendlyVisionError(errText, hadImage) {
  if (!hadImage) return null;
  const lower = String(errText).toLowerCase();
  const looks =
    lower.includes('image') ||
    lower.includes('vision') ||
    lower.includes('multimodal') ||
    lower.includes('content must be a string') ||
    lower.includes('does not support');
  if (!looks) return null;
  return (
    'Model yang dipilih kemungkinan besar TIDAK mendukung gambar (bukan model vision), ' +
    'jadi gambar yang kamu lampirkan ditolak provider. Ganti dulu ke model vision - kalau ' +
    'pakai Groq, coba "qwen/qwen3.8-27b" - lalu kirim ulang.\n\nError asli dari provider: ' +
    errText
  );
}

function buildOpenAIRequestBody(messages, model, temperature) {
  const hasSystem = messages.some((m) => m.role === 'system');
  const finalMessages = hasSystem
    ? messages.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n\n${LANGUAGE_SYSTEM_PROMPT}` } : m))
    : [{ role: 'system', content: LANGUAGE_SYSTEM_PROMPT }, ...messages];
  return { model, messages: finalMessages, temperature: temperature ?? 0.7, stream: true };
}

function toAnthropicContent(content) {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  return content
    .map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') {
        const m = /^data:([^;]+);base64,(.*)$/.exec(part.image_url?.url || '');
        if (!m) return null;
        return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      }
      return null;
    })
    .filter(Boolean);
}

function buildAnthropicRequestBody(messages, model) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const system = [...systemParts, LANGUAGE_SYSTEM_PROMPT].filter(Boolean).join('\n\n');
  const chatMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
  return { model, max_tokens: 4096, system, messages: chatMessages, stream: true };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'X-Accel-Buffering': 'no',
  ...CORS
};

async function providerError(providerRes, body) {
  const errText = await providerRes.text();
  const friendly = maybeFriendlyVisionError(errText, bodyHasImageContent(body));
  return json({ error: friendly || `API error: ${errText}` }, providerRes.status || 500);
}

async function proxyOpenAIChat(baseUrl, apiKey, body) {
  const providerRes = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!providerRes.ok || !providerRes.body) return providerError(providerRes, body);
  return new Response(providerRes.body, { status: 200, headers: SSE_HEADERS });
}

async function proxyAnthropicChat(baseUrl, apiKey, body) {
  const providerRes = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!providerRes.ok || !providerRes.body) return providerError(providerRes, body);

  // Ubah SSE ala Anthropic jadi SSE ala OpenAI supaya frontend tidak perlu diubah.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = '';
  let stopped = false;
  const out = new TransformStream({
    transform(chunk, controller) {
      if (stopped) return;
      buffer += dec.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload) continue;
        let c;
        try {
          c = JSON.parse(payload);
        } catch {
          continue;
        }
        if (c.type === 'content_block_delta' && c.delta?.text) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c.delta.text } }] })}\n\n`));
        } else if (c.type === 'message_stop') {
          stopped = true;
          break;
        }
      }
    },
    flush(controller) {
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
    }
  });
  return new Response(providerRes.body.pipeThrough(out), { status: 200, headers: SSE_HEADERS });
}

// ----------------------------- Handlers -----------------------------

async function handleModels(req, url, cfg) {
  const baseUrl = getBaseUrl(req, url, null, cfg);
  if (!baseUrl) return json({ error: 'Domain/base URL penyedia AI wajib diisi.' }, 400);
  const k = resolveApiKey(req, url, null, cfg);
  if (!k.apiKey) return keyError(k);
  try {
    const { style, models, detection } = await detectProviderFast(baseUrl, k.apiKey);
    setCachedDetection(baseUrl, k.apiKey, detection);
    return json({ models, style });
  } catch (err) {
    return json({ error: err.message || 'Gagal menghubungi penyedia AI.' }, 502);
  }
}

async function handleChat(req, url, cfg) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body request bukan JSON yang valid.' }, 400);
  }
  const { model, messages, temperature } = body || {};
  const baseUrl = getBaseUrl(req, url, body, cfg);
  if (!baseUrl) return json({ error: 'Domain/base URL penyedia AI wajib diisi.' }, 400);
  const k = resolveApiKey(req, url, body, cfg);
  if (!k.apiKey) return keyError(k);
  if (!model) return json({ error: 'Model belum dipilih.' }, 400);
  if (!Array.isArray(messages)) return json({ error: 'Format messages tidak valid.' }, 400);

  try {
    let detection = getCachedDetection(baseUrl, k.apiKey);
    if (!detection) {
      detection = (await detectProviderFast(baseUrl, k.apiKey)).detection;
      setCachedDetection(baseUrl, k.apiKey, detection);
    }
    const style = pickStyleForModel(detection, model);
    if (!style) return json({ error: 'Tidak berhasil terhubung ke provider untuk model ini.' }, 502);
    return style === 'anthropic'
      ? await proxyAnthropicChat(baseUrl, k.apiKey, buildAnthropicRequestBody(messages, model))
      : await proxyOpenAIChat(baseUrl, k.apiKey, buildOpenAIRequestBody(messages, model, temperature));
  } catch (err) {
    return json({ error: 'Gagal menghubungi penyedia AI: ' + err.message }, 500);
  }
}

export default {
  async fetch(req, env) {
    const cfg = getCfg(env);
    const url = new URL(req.url);
    const isApi = url.pathname === '/health' || url.pathname.startsWith('/api/');
    if (!isApi) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/health') return json({ status: 'ok' });
      if (url.pathname === '/api/models' && req.method === 'GET') return await handleModels(req, url, cfg);
      if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, url, cfg);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Terjadi error tak terduga di server: ' + (err?.message || String(err)) }, 500);
    }
  }
};
