class JimaniAdapter {
  constructor({ apiBase = 'https://openapi.jimani.online', basicHeader, apiKey, bearerToken } = {}) {
    this.apiBase = apiBase;
    this.basicHeader = basicHeader;
    this.apiKey = apiKey;
    this.bearer = bearerToken;
  }

  _authHeaders() {
    if (this.basicHeader) return { Authorization: this.basicHeader };
    if (this.bearer) return { Authorization: 'Bearer ' + this.bearer };
    if (this.apiKey) return { 'X-Api-Key': this.apiKey };
    throw new Error('Jimani adapter: no credentials configured');
  }

  async _req(method, path, body) {
    const init = { method, headers: { ...this._authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' } };
    if (body && method !== 'GET') init.body = JSON.stringify(body);
    const r = await fetch(this.apiBase + path, init);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, ok: r.ok, data };
  }

  async listLocations() {
    const r = await this._req('GET', '/api/HorecaReservation/GetHorecaReservationTables');
    if (!r.ok) throw new Error('Jimani listLocations failed: ' + JSON.stringify(r.data));
    const seen = new Map();
    for (const t of (r.data?.result || [])) {
      if (!seen.has(t.idLocation)) seen.set(t.idLocation, { id: String(t.idLocation), name: t.locationName || 'Location ' + t.idLocation });
    }
    return [...seen.values()];
  }

  async listReservationTypes(locationId, language = 1) {
    const qs = `?idLanguage=${language}` + (locationId ? `&locationId=${encodeURIComponent(locationId)}` : '');
    const r = await this._req('GET', '/api/HorecaReservation/GetHorecaReservationTypes' + qs);
    if (!r.ok) throw new Error('Jimani listReservationTypes failed');
    return (r.data?.result || []).map(t => ({
      id: String(t.idReservationtype),
      name: t.name,
      description: t.description,
      duration: t.duration,
      minGuests: t.minimumGuests,
      maxGuests: t.maximumGuests,
      timeInterval: t.timeInterval,
      minLeadTimeSeconds: t.minimumTimeBeforeInterval,
    }));
  }

  async checkAvailability({ typeId, fromDate, toDate, language = 1 }) {
    const r = await this._req('GET', `/api/HorecaReservation/GetHorecaReservationAvailability?reservationTypeId=${encodeURIComponent(typeId)}&idLanguage=${language}`);
    if (!r.ok) throw new Error('Jimani checkAvailability failed');
    const from = fromDate ? new Date(fromDate) : new Date();
    const to = toDate ? new Date(toDate) : new Date(from.getTime() + 14 * 86400000);
    const slots = [];
    for (const arr of (r.data?.result || [])) {
      for (const dateStr of (arr.openDates || [])) {
        const d = new Date(dateStr);
        if (d < from || d > to) continue;
        slots.push({ date: dateStr, time: arr.openFrom, guestCount: null, typeId, typeName: arr.name, arrangementId: arr.idArrangementType });
      }
    }
    return slots;
  }

  async listRequiredFields(typeId, language = 1) {
    const r = await this._req('GET', `/api/HorecaReservation/GetHorecaReservationFields?reservationTypeId=${encodeURIComponent(typeId)}&idLanguage=${language}`);
    if (!r.ok) throw new Error('Jimani listRequiredFields failed');
    const d = r.data?.result || {};
    const merge = (arr, required) => (arr || []).map(f => ({ id: String(f.idField), name: f.name, type: f.type, required, options: f.options || [] }));
    return [...merge(d.requiredFields, true), ...merge(d.optionalFields, false)];
  }

  async listProducts(typeId, language = 1) {
    const r = await this._req('GET', `/api/HorecaReservation/GetHorecaReservationProducts?reservationTypeId=${encodeURIComponent(typeId)}&idLanguage=${language}`);
    if (!r.ok) throw new Error('Jimani listProducts failed');
    return (r.data?.result || []).map(p => ({ id: String(p.idProduct), name: p.productName, description: p.productInfo, price: p.price1, currency: 'EUR' }));
  }

  async createReservation({ typeId, slot, guest, fields = [], baseUrl = 'https://clonecaller.com/book', language = 'en' }) {
    const body = {
      key: 'mcp-unified',
      baseUrl, language, idLanguage: 1,
      reservationTypeId: Number(typeId),
      date: slot.date, arrivaltime: slot.time, guestCount: slot.guestCount,
      guest, fields,
      guestFields: [
        { idGuestDetails: 1543, value: guest.firstName },
        { idGuestDetails: 1544, value: guest.lastName },
        { idGuestDetails: 1545, value: guest.email },
        ...(guest.phone ? [{ idGuestDetails: 1546, value: guest.phone }] : []),
      ],
      CombinationInfo: [],
    };
    const r = await this._req('POST', '/api/HorecaReservation/CreateReservation', body);
    const blob = JSON.stringify(r.data || {});
    const urlMatch = blob.match(/"(?:paymentUrl|payment_url|redirectUrl|redirect_url|widgetUrl|widget_url|checkoutUrl|checkout_url)"\s*:\s*"([^"]+)"/);
    return {
      id: r.data?.result?.reservationId || r.data?.result?.id || null,
      status: r.data?.isSuccess ? 'confirmed' : 'failed',
      slot, guest,
      paymentUrl: urlMatch ? urlMatch[1] : null,
      confirmationUrl: null,
      raw: r.data,
    };
  }

  async getReservation() { throw new Error('Jimani does not expose GET /reservations/{id}.'); }
  async cancelReservation() { throw new Error('Jimani does not expose cancel endpoint.'); }
  async listReservations() { throw new Error('Jimani does not expose reservation listing.'); }
}

module.exports = { JimaniAdapter };
