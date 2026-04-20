# mcp-jimani-online

Model Context Protocol (MCP) server that exposes the [Jimani Open API](https://openapi.jimani.online/swagger/index.html) to MCP-compatible LLM clients (Claude Desktop, Cursor, Anthropic API, and others).

Jimani Online is a HORECA (Hotel / Restaurant / Cafe) reservation and company management platform. This MCP server wraps its 15 REST endpoints as typed MCP tools so an LLM can manage reservations, company info, opening hours, tables, and system users through natural language.

## Features

- **Three auth modes** supported by Jimani API:
  - OAuth 2.0 Client Credentials (Bearer token from `/api/Token`) — recommended
  - API Key (`X-Api-Key` header)
  - Basic auth (Base64-encoded `ClientId:PartnerId`)
- **Per-session token management** — automatic Bearer caching + refresh
- **16 tools** covering:
  - Authentication (1)
  - Company info + contacts + system users + opening hours (7)
  - Reservations: types, availability, tables, fields, products, guest details, create (7)
  - Generic passthrough (`api_call`) for any endpoint
- **Streamable HTTP transport** compatible with Claude Desktop, Cursor, mcp-remote, and any MCP client
- **SSE transport** (legacy) also supported
- **Health check** at `/health`

## Live endpoint

- HTTPS: `https://mcp-jimani.sovanza.net/mcp`
- Health: `https://mcp-jimani.sovanza.net/health`
- Auth: Bearer `MCP_API_KEY` (server-side, not Jimani's)

## Quick start (Claude Desktop)

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jimani-online": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp-jimani.sovanza.net/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_API_KEY"
      ]
    }
  }
}
```

Then restart Claude Desktop. The Jimani tools appear under the hammer icon.

## Quick start (Cursor / other)

Point your MCP client at `https://mcp-jimani.sovanza.net/mcp` with header `Authorization: Bearer YOUR_MCP_API_KEY`.

## Run locally

```bash
git clone https://github.com/sovanza-inc/mcp-jimani-online.git
cd mcp-jimani-online
npm install
cp .env.example .env
# Fill in JIMANI_CLIENT_ID, JIMANI_PARTNER_ID (or JIMANI_API_KEY)
npm start
```

Server listens on `http://localhost:3102` by default.

## Tools

### Authentication
- `authenticate` — Obtain Bearer token via `/api/Token` (Client Credentials flow). Caches token on server for subsequent calls.
- `auth_status` — Check current auth state.
- `logout` — Clear cached token.

### Company
- `company_get_info` — `GET /api/Company/GetCompanyInfo`
- `company_update_info` — `PUT /api/Company/UpdateCompanyInfo`
- `company_main_contacts` — `GET /api/Company/GetCompanyMainContacts`
- `company_system_users` — `GET /api/Company/GetCompanySystemUsers`
- `company_update_system_user` — `PUT /api/Company/UpdateCompanySystemUser`
- `company_opening_hours` — `GET /api/Company/GetHorecaOpeningHours`
- `company_update_opening_hours` — `PUT /api/Company/UpdateHorecaOpeningHours`

### Reservation
- `reservation_types` — `GET /api/Reservation/GetHorecaReservationTypes?locationId=…`
- `reservation_availability` — `GET /api/Reservation/GetHorecaReservationAvailability?reservationTypeId=…`
- `reservation_tables` — `GET /api/Reservation/GetHorecaReservationTables`
- `reservation_fields` — `GET /api/Reservation/GetHorecaReservationFields?reservationTypeId=…`
- `reservation_products` — `GET /api/Reservation/GetHorecaReservationProducts?reservationTypeId=…`
- `reservation_guest_details` — `GET /api/Reservation/GetHorecaReservationGuestDetails?email=…`
- `reservation_create` — `POST /api/Reservation/CreateReservation`

### Generic
- `api_call` — Make any raw Jimani API request with method, path, body.

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `MCP_PORT` | MCP HTTP port (default 3102) | No |
| `MCP_API_KEY` | Secret for clients connecting to this MCP server | Yes (change default!) |
| `JIMANI_API_BASE` | Jimani Open API base URL | No (defaults to `https://openapi.jimani.online`) |
| `JIMANI_CLIENT_ID` | OAuth Client ID (for Client Credentials flow) | One of the three auth methods required |
| `JIMANI_PARTNER_ID` | OAuth Partner ID (pairs with `JIMANI_CLIENT_ID`) | Pairs with `JIMANI_CLIENT_ID` |
| `JIMANI_API_KEY` | Static API key (alternative to OAuth) | Alternative to OAuth |

## Architecture

```
┌─────────────────┐   HTTPS + Bearer   ┌──────────────────────┐
│ Claude / Cursor │ ─────────────────> │ mcp-jimani.sovanza…  │
│ (MCP client)    │                    │ Node.js MCP server   │
└─────────────────┘                    └──────────┬───────────┘
                                                  │
                                           ┌──────▼────────┐
                                           │ Jimani API    │
                                           │ openapi.      │
                                           │ jimani.online │
                                           └───────────────┘
```

The MCP server holds no Jimani data of its own — it's a thin, typed wrapper with per-session token caching.

## License

MIT
