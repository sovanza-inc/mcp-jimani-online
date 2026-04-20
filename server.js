// Lightweight .env loader (pm2 does not auto-load .env)
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("
");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch {}

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const http = require("http");

const API_BASE = process.env.JIMANI_API_BASE || "https://openapi.jimani.online";
const PORT = Number(process.env.MCP_PORT || 3102);
const MCP_API_KEY = process.env.MCP_API_KEY || "change-me-in-production";
const DEFAULT_CLIENT_ID = process.env.JIMANI_CLIENT_ID || "";
const DEFAULT_PARTNER_ID = process.env.JIMANI_PARTNER_ID || "";
const DEFAULT_STATIC_KEY = process.env.JIMANI_API_KEY || "";

// Node 18+ has global fetch, but keep node-fetch as fallback for older runtimes
let _fetchMod = null;
const getFetch = async () => {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  if (!_fetchMod) _fetchMod = await import("node-fetch");
  return _fetchMod.default;
};

// ========== AUTH STATE ==========
let authState = {
  bearer: null,
  bearerExpiry: 0,
  staticKey: DEFAULT_STATIC_KEY || null,
  clientId: DEFAULT_CLIENT_ID || null,
  partnerId: DEFAULT_PARTNER_ID || null,
};

async function obtainBearer() {
  if (!authState.clientId || !authState.partnerId) {
    throw new Error("No JIMANI_CLIENT_ID/JIMANI_PARTNER_ID configured. Call the 'authenticate' tool or set env vars.");
  }
  const fetch = await getFetch();
  const body = {
    client_id: authState.clientId,
    partner_id: authState.partnerId,
    grant_type: "client_credentials",
  };
  const res = await fetch(`${API_BASE}/api/Token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  const token = data.access_token || data.accessToken || data.token;
  const expiresIn = data.expires_in || data.expiresIn || 3600;
  if (!token) throw new Error(`No token in response: ${JSON.stringify(data).slice(0, 300)}`);
  authState.bearer = token;
  authState.bearerExpiry = Date.now() + (expiresIn - 60) * 1000;
  return { token, expiresIn, raw: data };
}

async function ensureBearer() {
  if (authState.bearer && Date.now() < authState.bearerExpiry) return authState.bearer;
  const r = await obtainBearer();
  return r.token;
}

// ========== API HELPER ==========
async function apiCall(method, path, body = null, opts = {}) {
  const fetch = await getFetch();
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };

  if (opts.auth === "apikey" || (!opts.auth && authState.staticKey && !authState.bearer && !authState.clientId)) {
    if (!authState.staticKey) throw new Error("No API key configured");
    headers["X-Api-Key"] = authState.staticKey;
  } else if (opts.auth === "bearer" || (!opts.auth && (authState.bearer || authState.clientId))) {
    const token = await ensureBearer();
    headers["Authorization"] = `Bearer ${token}`;
  }

  const init = { method, headers };
  if (body && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

const jsonContent = (data) => [{ type: "text", text: JSON.stringify(data, null, 2) }];

// ========== MCP SERVER ==========
function buildMcpServer() {
  const server = new McpServer({ name: "jimani-online", version: "1.0.0" });

  // ----- AUTH -----
  server.tool(
    "authenticate",
    "Obtain a Bearer token from Jimani /api/Token (Client Credentials). Subsequent calls auto-use the cached token.",
    {
      clientId: z.string().optional().describe("Jimani OAuth Client ID (overrides env)"),
      partnerId: z.string().optional().describe("Jimani OAuth Partner ID (overrides env)"),
      apiKey: z.string().optional().describe("Static X-Api-Key (alternative to OAuth)"),
    },
    async ({ clientId, partnerId, apiKey }) => {
      if (apiKey) {
        authState.staticKey = apiKey;
        authState.bearer = null;
        authState.bearerExpiry = 0;
        return { content: [{ type: "text", text: "Static API key set. Subsequent calls will use X-Api-Key." }] };
      }
      if (clientId) authState.clientId = clientId;
      if (partnerId) authState.partnerId = partnerId;
      const r = await obtainBearer();
      return { content: [{ type: "text", text: `Bearer token acquired. Expires in ${r.expiresIn}s.` }] };
    }
  );

  server.tool("auth_status", "Check current auth configuration and token state.", {}, async () => {
    const now = Date.now();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          apiBase: API_BASE,
          hasBearer: Boolean(authState.bearer),
          bearerExpiresInSeconds: authState.bearerExpiry > now ? Math.floor((authState.bearerExpiry - now) / 1000) : 0,
          clientIdConfigured: Boolean(authState.clientId),
          partnerIdConfigured: Boolean(authState.partnerId),
          staticKeyConfigured: Boolean(authState.staticKey),
        }, null, 2),
      }],
    };
  });

  server.tool("logout", "Clear the cached Bearer token (next call will re-auth if credentials still configured).", {}, async () => {
    authState.bearer = null;
    authState.bearerExpiry = 0;
    return { content: [{ type: "text", text: "Bearer token cleared." }] };
  });

  // ----- COMPANY -----
  server.tool("company_get_info", "GET /api/Company/GetCompanyInfo — Retrieve company details.", {}, async () => {
    const r = await apiCall("GET", "/api/Company/GetCompanyInfo");
    return { content: jsonContent(r) };
  });

  server.tool(
    "company_update_info",
    "PUT /api/Company/UpdateCompanyInfo — Update company details. Pass JSON body.",
    { body: z.string().describe("JSON string of UpdateCompanyInfoOpenAPICommand") },
    async ({ body }) => {
      const r = await apiCall("PUT", "/api/Company/UpdateCompanyInfo", JSON.parse(body));
      return { content: jsonContent(r) };
    }
  );

  server.tool("company_main_contacts", "GET /api/Company/GetCompanyMainContacts — List company main contacts.", {}, async () => {
    const r = await apiCall("GET", "/api/Company/GetCompanyMainContacts");
    return { content: jsonContent(r) };
  });

  server.tool("company_system_users", "GET /api/Company/GetCompanySystemUsers — List system users for the company.", {}, async () => {
    const r = await apiCall("GET", "/api/Company/GetCompanySystemUsers");
    return { content: jsonContent(r) };
  });

  server.tool(
    "company_update_system_user",
    "PUT /api/Company/UpdateCompanySystemUser — Update a system user.",
    { body: z.string().describe("JSON string of UpdateCompanySystemUserOpenAPICommand") },
    async ({ body }) => {
      const r = await apiCall("PUT", "/api/Company/UpdateCompanySystemUser", JSON.parse(body));
      return { content: jsonContent(r) };
    }
  );

  server.tool("company_opening_hours", "GET /api/Company/GetHorecaOpeningHours — Retrieve HORECA opening hours.", {}, async () => {
    const r = await apiCall("GET", "/api/Company/GetHorecaOpeningHours");
    return { content: jsonContent(r) };
  });

  server.tool(
    "company_update_opening_hours",
    "PUT /api/Company/UpdateHorecaOpeningHours — Update opening hours. Pass JSON body (HorecaOpeningHoursModel).",
    { body: z.string().describe("JSON string of HorecaOpeningHoursModel") },
    async ({ body }) => {
      const r = await apiCall("PUT", "/api/Company/UpdateHorecaOpeningHours", JSON.parse(body));
      return { content: jsonContent(r) };
    }
  );

  // ----- RESERVATION -----
  server.tool(
    "reservation_types",
    "GET /api/Reservation/GetHorecaReservationTypes — List reservation types available for a location.",
    { locationId: z.string().describe("Location ID") },
    async ({ locationId }) => {
      const r = await apiCall("GET", `/api/Reservation/GetHorecaReservationTypes?locationId=${encodeURIComponent(locationId)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_availability",
    "GET /api/Reservation/GetHorecaReservationAvailability — Check availability for a reservation type.",
    { reservationTypeId: z.string().describe("Reservation type ID") },
    async ({ reservationTypeId }) => {
      const r = await apiCall("GET", `/api/Reservation/GetHorecaReservationAvailability?reservationTypeId=${encodeURIComponent(reservationTypeId)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool("reservation_tables", "GET /api/Reservation/GetHorecaReservationTables — List all HORECA tables.", {}, async () => {
    const r = await apiCall("GET", "/api/Reservation/GetHorecaReservationTables");
    return { content: jsonContent(r) };
  });

  server.tool(
    "reservation_fields",
    "GET /api/Reservation/GetHorecaReservationFields — List custom fields for a reservation type.",
    { reservationTypeId: z.string().describe("Reservation type ID") },
    async ({ reservationTypeId }) => {
      const r = await apiCall("GET", `/api/Reservation/GetHorecaReservationFields?reservationTypeId=${encodeURIComponent(reservationTypeId)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_products",
    "GET /api/Reservation/GetHorecaReservationProducts — List products available for a reservation type.",
    { reservationTypeId: z.string().describe("Reservation type ID") },
    async ({ reservationTypeId }) => {
      const r = await apiCall("GET", `/api/Reservation/GetHorecaReservationProducts?reservationTypeId=${encodeURIComponent(reservationTypeId)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_guest_details",
    "GET /api/Reservation/GetHorecaReservationGuestDetails — Look up guest details by email.",
    { email: z.string().describe("Guest email address") },
    async ({ email }) => {
      const r = await apiCall("GET", `/api/Reservation/GetHorecaReservationGuestDetails?email=${encodeURIComponent(email)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_create",
    "POST /api/Reservation/CreateReservation — Create a new reservation. Pass JSON body (CreateReservationWidgetCommand).",
    { body: z.string().describe("JSON string of CreateReservationWidgetCommand") },
    async ({ body }) => {
      const r = await apiCall("POST", "/api/Reservation/CreateReservation", JSON.parse(body));
      return { content: jsonContent(r) };
    }
  );

  // ----- GENERIC -----
  server.tool(
    "api_call",
    "Make any raw Jimani Open API call. Supports GET/POST/PUT/DELETE/PATCH.",
    {
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      path: z.string().describe("Path starting with /api/..."),
      body: z.string().optional().describe("Optional JSON body string"),
    },
    async ({ method, path, body }) => {
      const r = await apiCall(method, path, body ? JSON.parse(body) : null);
      return { content: jsonContent(r) };
    }
  );

  return server;
}

// ========== HTTP SERVER ==========
const sseTransports = {};
const httpTransports = {};

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      server: "mcp-jimani-online",
      version: "1.0.0",
      apiBase: API_BASE,
      sseSessions: Object.keys(sseTransports).length,
      httpSessions: Object.keys(httpTransports).length,
    }));
    return;
  }

  // Auth gate
  const auth = req.headers["authorization"] || "";
  const urlKey = url.searchParams.get("key");
  const providedKey = auth.replace(/^Bearer\s+/i, "") || urlKey;
  if (providedKey !== MCP_API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — pass Bearer MCP_API_KEY in Authorization header or ?key=..." }));
    return;
  }

  // Streamable HTTP transport (primary)
  if (url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (req.method === "POST") {
        if (sessionId && httpTransports[sessionId]) {
          await httpTransports[sessionId].handleRequest(req, res);
          return;
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        const newSid = transport.sessionId;
        if (newSid) {
          httpTransports[newSid] = transport;
          transport.onclose = () => delete httpTransports[newSid];
        }
        return;
      }
      if (req.method === "GET" && sessionId && httpTransports[sessionId]) {
        await httpTransports[sessionId].handleRequest(req, res);
        return;
      }
      if (req.method === "DELETE" && sessionId && httpTransports[sessionId]) {
        await httpTransports[sessionId].handleRequest(req, res);
        delete httpTransports[sessionId];
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    } catch (e) {
      console.error("[/mcp]", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // SSE transport (legacy)
  if (url.pathname === "/sse") {
    if (req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sseTransports[transport.sessionId] = transport;
      res.on("close", () => delete sseTransports[transport.sessionId]);
      const server = buildMcpServer();
      await server.connect(transport);
      return;
    }
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    const sid = url.searchParams.get("sessionId");
    const transport = sseTransports[sid];
    if (transport) { await transport.handlePostMessage(req, res); return; }
    res.writeHead(400); res.end("No transport"); return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "Not found",
    endpoints: ["/health", "/mcp (Streamable HTTP)", "/sse (legacy SSE)", "/messages (SSE POST)"],
  }));
});

httpServer.listen(PORT, () => {
  console.log(`[mcp-jimani-online] Listening on :${PORT}`);
  console.log(`[mcp-jimani-online] API base: ${API_BASE}`);
  console.log(`[mcp-jimani-online] MCP endpoint: /mcp (auth: Bearer MCP_API_KEY)`);
  console.log(`[mcp-jimani-online] Health: /health`);
});
