class ResyAdapter {
  constructor(_c = {}) { this.provider = 'resy'; }
  async listLocations()       { throw new Error('Resy adapter not yet implemented.'); }
  async listReservationTypes(){ throw new Error('Resy adapter not yet implemented.'); }
  async checkAvailability()   { throw new Error('Resy adapter not yet implemented.'); }
  async listRequiredFields()  { throw new Error('Resy adapter not yet implemented.'); }
  async listProducts()        { throw new Error('Resy adapter not yet implemented.'); }
  async createReservation()   { throw new Error('Resy adapter not yet implemented.'); }
  async getReservation()      { throw new Error('Resy adapter not yet implemented.'); }
  async cancelReservation()   { throw new Error('Resy adapter not yet implemented.'); }
  async listReservations()    { throw new Error('Resy adapter not yet implemented.'); }
}

module.exports = { ResyAdapter };
