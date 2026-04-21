class TheForkAdapter {
  constructor(_c = {}) { this.provider = 'thefork'; }
  async listLocations()       { throw new Error('TheFork adapter not yet implemented.'); }
  async listReservationTypes(){ throw new Error('TheFork adapter not yet implemented.'); }
  async checkAvailability()   { throw new Error('TheFork adapter not yet implemented.'); }
  async listRequiredFields()  { throw new Error('TheFork adapter not yet implemented.'); }
  async listProducts()        { throw new Error('TheFork adapter not yet implemented.'); }
  async createReservation()   { throw new Error('TheFork adapter not yet implemented.'); }
  async getReservation()      { throw new Error('TheFork adapter not yet implemented.'); }
  async cancelReservation()   { throw new Error('TheFork adapter not yet implemented.'); }
  async listReservations()    { throw new Error('TheFork adapter not yet implemented.'); }
}

module.exports = { TheForkAdapter };
