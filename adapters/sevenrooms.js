class SevenRoomsAdapter {
  constructor(_c = {}) { this.provider = 'sevenrooms'; }
  async listLocations()       { throw new Error('SevenRooms adapter not yet implemented.'); }
  async listReservationTypes(){ throw new Error('SevenRooms adapter not yet implemented.'); }
  async checkAvailability()   { throw new Error('SevenRooms adapter not yet implemented.'); }
  async listRequiredFields()  { throw new Error('SevenRooms adapter not yet implemented.'); }
  async listProducts()        { throw new Error('SevenRooms adapter not yet implemented.'); }
  async createReservation()   { throw new Error('SevenRooms adapter not yet implemented.'); }
  async getReservation()      { throw new Error('SevenRooms adapter not yet implemented.'); }
  async cancelReservation()   { throw new Error('SevenRooms adapter not yet implemented.'); }
  async listReservations()    { throw new Error('SevenRooms adapter not yet implemented.'); }
}

module.exports = { SevenRoomsAdapter };
