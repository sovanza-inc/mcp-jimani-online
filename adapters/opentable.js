class OpenTableAdapter {
  constructor(_c = {}) { this.provider = 'opentable'; }
  async listLocations()       { throw new Error('OpenTable adapter not yet implemented.'); }
  async listReservationTypes(){ throw new Error('OpenTable adapter not yet implemented.'); }
  async checkAvailability()   { throw new Error('OpenTable adapter not yet implemented.'); }
  async listRequiredFields()  { throw new Error('OpenTable adapter not yet implemented.'); }
  async listProducts()        { throw new Error('OpenTable adapter not yet implemented.'); }
  async createReservation()   { throw new Error('OpenTable adapter not yet implemented.'); }
  async getReservation()      { throw new Error('OpenTable adapter not yet implemented.'); }
  async cancelReservation()   { throw new Error('OpenTable adapter not yet implemented.'); }
  async listReservations()    { throw new Error('OpenTable adapter not yet implemented.'); }
}

module.exports = { OpenTableAdapter };
