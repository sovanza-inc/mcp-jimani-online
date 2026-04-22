// Lightweight .env loader (pm2 does not auto-load .env)
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
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
// OAuth / Bearer credentials are a DIFFERENT pair from Basic (ClientId:PartnerId).
// Jimani's /api/Token expects OAuth2 snake_case: client_id + client_secret + grant_type.
const DEFAULT_OAUTH_CLIENT_ID = process.env.JIMANI_OAUTH_CLIENT_ID || "";
const DEFAULT_OAUTH_CLIENT_SECRET = process.env.JIMANI_OAUTH_CLIENT_SECRET || "";

// Node 18+ has global fetch, but keep node-fetch as fallback for older runtimes
let _fetchMod = null;
const getFetch = async () => {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  if (!_fetchMod) _fetchMod = await import("node-fetch");
  return _fetchMod.default;
};

// ========== AUTH STATE ==========
// mode: "basic" | "bearer" | "apikey"
const DEFAULT_MODE = (process.env.JIMANI_AUTH_MODE || "").toLowerCase() ||
  (DEFAULT_STATIC_KEY ? "apikey" : (DEFAULT_CLIENT_ID && DEFAULT_PARTNER_ID ? "basic" : null));

let authState = {
  mode: DEFAULT_MODE,
  bearer: null,
  bearerExpiry: 0,
  staticKey: DEFAULT_STATIC_KEY || null,
  clientId: DEFAULT_CLIENT_ID || null,
  partnerId: DEFAULT_PARTNER_ID || null,
  oauthClientId: DEFAULT_OAUTH_CLIENT_ID || null,
  oauthClientSecret: DEFAULT_OAUTH_CLIENT_SECRET || null,
  companyId: null,  // extracted from JWT claims after obtaining bearer
};

function basicHeader() {
  if (!authState.clientId || !authState.partnerId) throw new Error("Basic auth requires clientId + partnerId");
  const raw = authState.clientId + ":" + authState.partnerId;
  return "Basic " + Buffer.from(raw, "utf-8").toString("base64");
}

async function obtainBearer() {
  // OAuth Client Credentials uses SEPARATE credentials from Basic auth.
  // Basic:     ClientId:PartnerId  (e.g. "basic-client-01":"basic-auth-partner")
  // OAuth:     ClientId:SecretKey  (e.g. "jwt-client-01":"s3cr3t-k3y-...")
  const cid = authState.oauthClientId || authState.clientId;
  const sec = authState.oauthClientSecret;
  if (!cid || !sec) {
    throw new Error("No JIMANI_OAUTH_CLIENT_ID / JIMANI_OAUTH_CLIENT_SECRET configured. Call 'authenticate' with mode='bearer' + clientId + clientSecret, or set env vars.");
  }
  const fetch = await getFetch();
  const body = {
    client_id: cid,
    client_secret: sec,
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
  // Decode JWT claims to capture CompanyId (needed by CreateReservation body)
  try {
    const parts = token.split(".");
    if (parts.length >= 2) {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (claims.CompanyId) authState.companyId = Number(claims.CompanyId);
    }
  } catch {}
  return { token, expiresIn, companyId: authState.companyId, raw: data };
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
  const mode = opts.auth || authState.mode;

  if (mode === "apikey") {
    if (!authState.staticKey) throw new Error("apikey mode requires JIMANI_API_KEY");
    headers["X-Api-Key"] = authState.staticKey;
  } else if (mode === "basic") {
    headers["Authorization"] = basicHeader();
  } else if (mode === "bearer") {
    const token = await ensureBearer();
    headers["Authorization"] = "Bearer " + token;
  } else {
    throw new Error("No auth configured. Call authenticate or set JIMANI_AUTH_MODE.");
  }

  const init = { method, headers };
  if (body && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, init);
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
    "Configure Jimani auth. Three modes: basic (Authorization: Basic base64(ClientId:PartnerId)), bearer (OAuth2 /api/Token with ClientId + ClientSecret — different credentials from Basic), apikey (X-Api-Key). Bearer tokens are JWTs with ~1 hour TTL, cached until 60s before expiry.",
    {
      mode: z.enum(["basic", "bearer", "apikey"]).optional(),
      clientId: z.string().optional().describe("Basic ClientId OR OAuth ClientId depending on mode"),
      partnerId: z.string().optional().describe("Basic auth PartnerId"),
      clientSecret: z.string().optional().describe("OAuth client secret — used when mode=bearer"),
      apiKey: z.string().optional().describe("Static X-Api-Key"),
    },
    async ({ mode, clientId, partnerId, clientSecret, apiKey }) => {
      if (apiKey) authState.staticKey = apiKey;
      if (clientSecret) authState.oauthClientSecret = clientSecret;
      if (clientId) {
        // When mode=bearer, store under oauthClientId; otherwise under Basic clientId
        if (mode === "bearer" || clientSecret) authState.oauthClientId = clientId;
        else authState.clientId = clientId;
      }
      if (partnerId) authState.partnerId = partnerId;

      let resolved = mode;
      if (!resolved) {
        if (apiKey) resolved = "apikey";
        else if (clientSecret || (clientId && clientSecret)) resolved = "bearer";
        else if (clientId && partnerId) resolved = "basic";
        else if (authState.staticKey) resolved = "apikey";
        else if (authState.oauthClientId && authState.oauthClientSecret) resolved = "bearer";
        else if (authState.clientId && authState.partnerId) resolved = "basic";
      }
      if (!resolved) {
        return { content: [{ type: "text", text: "No credentials supplied. Pass apiKey, or clientId+partnerId for basic, or clientId+clientSecret for bearer." }] };
      }
      authState.mode = resolved;

      if (resolved === "apikey") {
        authState.bearer = null;
        authState.bearerExpiry = 0;
        return { content: [{ type: "text", text: "Mode: apikey. Using X-Api-Key header." }] };
      }
      if (resolved === "basic") {
        authState.bearer = null;
        authState.bearerExpiry = 0;
        return { content: [{ type: "text", text: "Mode: basic. Authorization: Basic base64(clientId:partnerId)." }] };
      }
      if (resolved === "bearer") {
        const r = await obtainBearer();
        return { content: [{ type: "text", text: `Mode: bearer. Token acquired, expires in ${r.expiresIn}s. CompanyId from JWT: ${r.companyId || "(not present)"}` }] };
      }
    }
  );
  server.tool("auth_status", "Check current auth configuration and token state.", {}, async () => {
    const now = Date.now();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          apiBase: API_BASE,
          mode: authState.mode || "unset",
          hasBearer: Boolean(authState.bearer),
          bearerExpiresInSeconds: authState.bearerExpiry > now ? Math.floor((authState.bearerExpiry - now) / 1000) : 0,
          companyId: authState.companyId,
          clientIdConfigured: Boolean(authState.clientId),
          partnerIdConfigured: Boolean(authState.partnerId),
          oauthClientIdConfigured: Boolean(authState.oauthClientId),
          oauthClientSecretConfigured: Boolean(authState.oauthClientSecret),
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

    server.tool(
    "company_opening_hours_for_date",
    "GET /api/Company/GetHorecaOpeningAndClosingHoursForDate — Retrieve HORECA opening hours for a specific date (v1.2 endpoint, replaces the unfiltered GetHorecaOpeningHours).",
    {
      date: z.string().describe("ISO date YYYY-MM-DD"),
    },
    async ({ date }) => {
      const r = await apiCall("GET", `/api/Company/GetHorecaOpeningAndClosingHoursForDate?date=${encodeURIComponent(date)}`);
      return { content: jsonContent(r) };
    }
  );
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
    "GET /api/HorecaReservation/GetHorecaReservationTypes — List reservation types available for a location.",
    { locationId: z.string().describe("Location ID") },
    async ({ locationId }) => {
      const r = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationTypes?locationId=${encodeURIComponent(locationId)}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_availability",
    "GET /api/HorecaReservation/GetHorecaReservationAvailability — Returns per-arrangement open hours + open dates for a reservation type. Client-side filters openDates to fromDate..toDate window to prevent 90k+ char responses.",
    {
      reservationTypeId: z.string().describe("Reservation type ID"),
      idLanguage: z.number().optional().default(1).describe("Language ID (1=English, required by Jimani)"),
      fromDate: z.string().optional().describe("ISO date YYYY-MM-DD — defaults to today"),
      toDate: z.string().optional().describe("ISO date YYYY-MM-DD — defaults to fromDate + 14 days"),
    },
    async ({ reservationTypeId, idLanguage, fromDate, toDate }) => {
      const r = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationAvailability?idReservationType=${encodeURIComponent(reservationTypeId)}&idLanguage=${idLanguage}`);
      if (!r.ok || !r.data || !Array.isArray(r.data.result)) {
        return { content: jsonContent(r) };
      }
      const from = fromDate ? new Date(fromDate) : new Date();
      from.setHours(0, 0, 0, 0);
      const to = toDate ? new Date(toDate) : new Date(from.getTime() + 14 * 86400000);
      to.setHours(23, 59, 59, 999);
      const trimmed = r.data.result.map((arr) => {
        const dates = (arr.openDates || []).filter((d) => {
          const dt = new Date(d);
          return dt >= from && dt <= to;
        });
        return { ...arr, openDates: dates, _totalOpenDates: (arr.openDates || []).length };
      });
      return {
        content: jsonContent({
          ...r,
          data: {
            ...r.data,
            result: trimmed,
            _meta: {
              window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
              note: "openDates filtered client-side. Pass fromDate/toDate to change window.",
            },
          },
        }),
      };
    }
  );

  server.tool("reservation_tables", "GET /api/HorecaReservation/GetHorecaReservationTables — List all HORECA tables.", {}, async () => {
    const r = await apiCall("GET", "/api/HorecaReservation/GetHorecaReservationTables");
    return { content: jsonContent(r) };
  });

  server.tool(
    "reservation_fields",
    "GET /api/HorecaReservation/GetHorecaReservationFields — List required + optional custom fields for a reservation type. Includes field types (text/select/radio/textarea/label) and options.",
    {
      reservationTypeId: z.string().describe("Reservation type ID"),
      idLanguage: z.number().optional().default(1).describe("Language ID (1=English, required by Jimani)"),
    },
    async ({ reservationTypeId, idLanguage }) => {
      const r = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationFields?idReservationType=${encodeURIComponent(reservationTypeId)}&idLanguage=${idLanguage}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_products",
    "GET /api/HorecaReservation/GetHorecaReservationProducts — List upsell/deposit products for a reservation type. Includes 5 price tiers per product.",
    {
      reservationTypeId: z.string().describe("Reservation type ID"),
      idLanguage: z.number().optional().default(1).describe("Language ID (1=English, required by Jimani)"),
    },
    async ({ reservationTypeId, idLanguage }) => {
      const r = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationProducts?idReservationType=${encodeURIComponent(reservationTypeId)}&idLanguage=${idLanguage}`);
      return { content: jsonContent(r) };
    }
  );

  server.tool(
    "reservation_guest_fields",
    "GET /api/HorecaReservation/GetHorecaReservationGuestFields — Returns guest input field schema (salutation, firstname, etc). v1.2: renamed from GetHorecaReservationGuestDetails.",
    {
      email: z.string().optional().describe("Guest email (ignored by Jimani in current impl)"),
      idLanguage: z.number().optional().default(1).describe("Language ID (1=English, required by Jimani)"),
    },
    async ({ email, idLanguage }) => {
      const qs = `IdLanguage=${idLanguage}` + (email ? `&email=${encodeURIComponent(email)}` : "");
      const r = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationGuestFields?${qs}`);
      return { content: jsonContent(r) };
    }
  );

    server.tool(
    "reservation_create",
    "POST /api/HorecaReservation/CreateReservation — Create a reservation using the v1.2 CreateReservationForOpenAICommand schema. Cleanly typed, replaces the v1.0 body with key/baseUrl/CombinationInfo cruft.",
    {
      idReservationtype: z.number().describe("Reservation type ID"),
      idArrangementtype: z.number().optional().describe("Arrangement type ID (Diner=1641 / Lunch=... — from reservation_availability.result[].idArrangementType)"),
      totalGuests: z.number().describe("Number of guests"),
      arrivalDate: z.string().describe("ISO date-time (e.g. 2026-05-15T19:00:00)"),
      arrivalTime: z.string().describe("HH:mm:ss (e.g. 19:00:00)"),
      idLanguage: z.number().optional().default(1).describe("Language ID (1 = English)"),
      idCompany: z.number().describe("Company ID — from company_get_info.result.idCompany (e.g. 100305)"),
      widgetId: z.number().optional().default(0).describe("Widget ID — 0 for API/MCP integrations"),
      reservationRequest: z.boolean().optional().default(false),
      reservationRequestMin: z.number().optional().default(0),
      mainModuleId: z.number().optional().default(0),
      guestFields: z.array(z.object({
        idfield: z.string().describe("Guest field ID as string (from reservation_guest_fields)"),
        data: z.string().describe("Field value"),
      })).describe("Guest info (salutation, firstname, lastname, email, phone)"),
      fields: z.array(z.object({
        idfield: z.number().describe("Custom field ID (from reservation_fields)"),
        data: z.any().describe("Field value — string, number, or null depending on type"),
      })).optional().default([]).describe("Custom field answers for this reservation type"),
    },
    async (args) => {
      const body = {
        idReservationtype: args.idReservationtype,
        idArrangementtype: args.idArrangementtype ?? 0,
        totalGuests: args.totalGuests,
        arrivalDate: args.arrivalDate,
        arrivalTime: args.arrivalTime,
        idLanguage: args.idLanguage ?? 1,
        idCompany: args.idCompany,
        widgetId: args.widgetId ?? 0,
        reservationRequest: args.reservationRequest ?? false,
        reservationRequestMin: args.reservationRequestMin ?? 0,
        mainModuleId: args.mainModuleId ?? 0,
        guestFields: args.guestFields,
        fields: args.fields ?? [],
      };
      const r = await apiCall("POST", "/api/HorecaReservation/CreateReservation", body);
      return { content: jsonContent({ request: body, response: r }) };
    }
  );
  // Workflow macro: discover → validate → create in one shot
  server.tool(
    "book_reservation",
    "Macro: one-shot booking helper. Fetches reservation_types for locationId, validates the chosen type against guestCount and minimumTimeBeforeInterval, then creates the reservation. Returns step-by-step trace.",
    {
      locationId: z.string().describe("Location ID (e.g. '4080' for Restaurant)"),
      reservationTypeId: z.number().describe("Reservation type ID (from reservation_types)"),
      date: z.string().describe("Reservation date YYYY-MM-DD"),
      arrivaltime: z.string().describe("Arrival time HH:mm:ss"),
      guestCount: z.number(),
      guest: z.object({
        firstName: z.string(),
        lastName: z.string(),
        email: z.string(),
        phone: z.string().optional(),
      }),
      language: z.string().optional().default("en"),
    },
    async (args) => {
      const trace = [];
      // Step 1: validate type against location
      const typesRes = await apiCall("GET", `/api/HorecaReservation/GetHorecaReservationTypes?locationId=${encodeURIComponent(args.locationId)}`);
      trace.push({ step: "fetch_types", status: typesRes.status, count: Array.isArray(typesRes.data?.result) ? typesRes.data.result.length : 0 });
      if (!typesRes.ok) return { content: jsonContent({ trace, error: "Failed to fetch types", details: typesRes }) };

      const type = typesRes.data.result.find((t) => t.idReservationtype === args.reservationTypeId);
      if (!type) return { content: jsonContent({ trace, error: `Reservation type ${args.reservationTypeId} not found in location ${args.locationId}` }) };
      trace.push({ step: "validate_type", found: true, minGuests: type.minimumGuests, maxGuests: type.maximumGuests, duration: type.duration });

      if (args.guestCount < type.minimumGuests || args.guestCount > type.maximumGuests) {
        return { content: jsonContent({ trace, error: `Guest count ${args.guestCount} out of range [${type.minimumGuests}, ${type.maximumGuests}]` }) };
      }

      // Step 2: minimum lead time check
      if (type.minimumTimeBeforeInterval > 0) {
        const now = Date.now();
        const target = new Date(`${args.date}T${args.arrivaltime}Z`).getTime();
        const leadMs = target - now;
        const requiredMs = type.minimumTimeBeforeInterval * 1000;
        if (leadMs < requiredMs) {
          return { content: jsonContent({ trace, error: `Lead time too short: ${Math.floor(leadMs/3600000)}h vs required ${Math.floor(requiredMs/3600000)}h` }) };
        }
        trace.push({ step: "lead_time_ok", leadHours: Math.floor(leadMs/3600000), requiredHours: Math.floor(requiredMs/3600000) });
      }

      // Step 3: create
      const body = {
        key: "mcp-book-reservation",
        baseUrl: "https://jimaniai.sovanza.net",
        language: args.language,
        reservationTypeId: args.reservationTypeId,
        date: args.date,
        arrivaltime: args.arrivaltime,
        guestCount: args.guestCount,
        guest: args.guest,
        fields: [],
        guestFields: [
          { idGuestDetails: 1543, value: args.guest.firstName },
          { idGuestDetails: 1544, value: args.guest.lastName },
          { idGuestDetails: 1545, value: args.guest.email },
          ...(args.guest.phone ? [{ idGuestDetails: 1546, value: args.guest.phone }] : []),
        ],
        CombinationInfo: {},
      };
      const createRes = await apiCall("POST", "/api/HorecaReservation/CreateReservation", body);
      trace.push({ step: "create", status: createRes.status, ok: createRes.ok });
      return { content: jsonContent({ trace, request: body, response: createRes }) };
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


  // ── ACTIVITY (Attraction) opening hours — added in API v1.1 ──
    server.tool(
    "company_activity_opening_hours_for_date",
    "GET /api/Company/GetActivityOpeningAndClosingHoursForDate — Retrieve activity/attraction opening hours for a specific date (v1.2, date-filtered).",
    {
      date: z.string().describe("ISO date YYYY-MM-DD"),
    },
    async ({ date }) => {
      const r = await apiCall("GET", `/api/Company/GetActivityOpeningAndClosingHoursForDate?date=${encodeURIComponent(date)}`);
      return { content: jsonContent(r) };
    }
  );
  server.tool(
    "company_update_activity_opening_hours",
    "PUT /api/Company/UpdateActivityOpeningHours — Update activity/attraction opening hours.",
    { body: z.string().describe("JSON string of OpeningHoursModel") },
    async ({ body }) => {
      const r = await apiCall("PUT", "/api/Company/UpdateActivityOpeningHours", JSON.parse(body));
      return { content: jsonContent(r) };
    }
  );


  // ═══════════════════════════════════════════════════════════════
  // PROVIDER-AGNOSTIC BOOKING TOOLS
  // Dispatches to jimani / zenchef / opentable / thefork / resy / sevenrooms
  // ═══════════════════════════════════════════════════════════════
  const { getAdapter: _getAdapter, SUPPORTED: _SUPPORTED } = require('./adapters');

  function _buildAdapter(provider) {
    if (provider === 'jimani' || !provider) {
      const basic = (authState.clientId && authState.partnerId)
        ? 'Basic ' + Buffer.from(authState.clientId + ':' + authState.partnerId, 'utf-8').toString('base64')
        : null;
      return _getAdapter('jimani', {
        apiBase: API_BASE,
        basicHeader: basic,
        apiKey: authState.staticKey || null,
        bearerToken: authState.bearer || null,
      });
    }
    return _getAdapter(provider, {});
  }

  const _providerEnum = z.enum(['jimani','zenchef','opentable','thefork','resy','sevenrooms']);

  server.tool('booking_providers', 'List which reservation providers this MCP supports.', {}, async () => ({
    content: jsonContent({ supported: _SUPPORTED, live: ['jimani'], stubs: _SUPPORTED.filter(p => p !== 'jimani') })
  }));

  server.tool('booking_locations', 'List locations/restaurants on a provider.',
    { provider: _providerEnum.default('jimani') },
    async ({ provider }) => {
      try { return { content: jsonContent({ provider, locations: await _buildAdapter(provider).listLocations() }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

  server.tool('booking_reservation_types', 'List reservation types for a location.',
    { provider: _providerEnum.default('jimani'), locationId: z.string(), language: z.number().optional() },
    async ({ provider, locationId, language }) => {
      try { return { content: jsonContent({ provider, locationId, types: await _buildAdapter(provider).listReservationTypes(locationId, language) }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

  server.tool('booking_availability', 'Check slots for a type in a date window.',
    { provider: _providerEnum.default('jimani'), locationId: z.string().optional(), typeId: z.string(),
      fromDate: z.string(), toDate: z.string().optional(), guestCount: z.number().optional(), language: z.number().optional() },
    async (args) => {
      try {
        const slots = await _buildAdapter(args.provider).checkAvailability(args);
        return { content: jsonContent({ provider: args.provider, typeId: args.typeId, slots: slots.slice(0, 60), totalSlots: slots.length }) };
      } catch (e) { return { content: jsonContent({ provider: args.provider, error: e.message }) }; }
    });

  server.tool('booking_required_fields', 'List required + optional fields for a reservation type.',
    { provider: _providerEnum.default('jimani'), typeId: z.string(), language: z.number().optional() },
    async ({ provider, typeId, language }) => {
      try { return { content: jsonContent({ provider, typeId, fields: await _buildAdapter(provider).listRequiredFields(typeId, language) }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

  server.tool('booking_products', 'List upsell / deposit products for a type.',
    { provider: _providerEnum.default('jimani'), typeId: z.string(), language: z.number().optional() },
    async ({ provider, typeId, language }) => {
      try { return { content: jsonContent({ provider, typeId, products: await _buildAdapter(provider).listProducts(typeId, language) }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

  server.tool('booking_create', 'Create a reservation on any supported provider. Unified response incl. paymentUrl if deposit required.',
    { provider: _providerEnum.default('jimani'), locationId: z.string().optional(), typeId: z.string(),
      slot: z.object({ date: z.string(), time: z.string(), guestCount: z.number() }),
      guest: z.object({ firstName: z.string(), lastName: z.string(), email: z.string(), phone: z.string().optional(), salutation: z.string().optional() }),
      fields: z.array(z.object({ idField: z.number(), value: z.string() })).optional(),
      baseUrl: z.string().optional().default('https://clonecaller.com/book'),
      language: z.string().optional().default('en') },
    async (args) => {
      try { return { content: jsonContent({ provider: args.provider, reservation: await _buildAdapter(args.provider).createReservation(args) }) }; }
      catch (e) { return { content: jsonContent({ provider: args.provider, error: e.message }) }; }
    });

  server.tool('booking_get', 'Fetch a reservation by ID (provider-dependent).',
    { provider: _providerEnum.default('jimani'), reservationId: z.string() },
    async ({ provider, reservationId }) => {
      try { return { content: jsonContent({ provider, reservation: await _buildAdapter(provider).getReservation(reservationId) }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

  server.tool('booking_cancel', 'Cancel a reservation (provider-dependent).',
    { provider: _providerEnum.default('jimani'), reservationId: z.string(), reason: z.string().optional() },
    async ({ provider, reservationId, reason }) => {
      try { return { content: jsonContent({ provider, result: await _buildAdapter(provider).cancelReservation(reservationId, reason) }) }; }
      catch (e) { return { content: jsonContent({ provider, error: e.message }) }; }
    });

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
