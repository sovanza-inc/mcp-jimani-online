const { JimaniAdapter } = require('./jimani');
const { ZenchefAdapter } = require('./zenchef');
const { OpenTableAdapter } = require('./opentable');
const { TheForkAdapter } = require('./thefork');
const { ResyAdapter } = require('./resy');
const { SevenRoomsAdapter } = require('./sevenrooms');

const REGISTRY = {
  jimani: JimaniAdapter,
  zenchef: ZenchefAdapter,
  opentable: OpenTableAdapter,
  thefork: TheForkAdapter,
  resy: ResyAdapter,
  sevenrooms: SevenRoomsAdapter,
};

function getAdapter(provider, config) {
  const Cls = REGISTRY[provider];
  if (!Cls) throw new Error('Unknown reservation provider: ' + provider + '. Supported: ' + Object.keys(REGISTRY).join(', '));
  return new Cls(config);
}

module.exports = { getAdapter, SUPPORTED: Object.keys(REGISTRY) };
