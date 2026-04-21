class ZenchefAdapter {
  constructor(_c = {}) { this.provider = 'zenchef'; }
  async listLocations()       { throw new Error('Zenchef adapter not yet implemented.'); }
  async listReservationTypes(){ throw new Error('Zenchef adapter not yet implemented.'); }
  async checkAvailability()   { throw new Error('Zenchef adapter not yet implemented.'); }
  async listRequiredFields()  { throw new Error('Zenchef adapter not yet implemented.'); }
  async listProducts()        { throw new Error('Zenchef adapter not yet implemented.'); }
  async createReservation()   { throw new Error('Zenchef adapter not yet implemented.'); }
  async getReservation()      { throw new Error('Zenchef adapter not yet implemented.'); }
  async cancelReservation()   { throw new Error('Zenchef adapter not yet implemented.'); }
  async listReservations()    { throw new Error('Zenchef adapter not yet implemented.'); }
}

module.exports = { ZenchefAdapter };
