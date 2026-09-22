/**
 * The public customer-economy module: views import only this.
 *
 * The fixture is deliberately NOT exported here. It is test/development data,
 * imported by path from `./customerEconomy.fixture` and injected explicitly,
 * so a production bundle cannot pick it up through this module.
 */
export * from './customerEconomy.models';
export * from './customerEconomy.adapter';
export * from './customerEconomy.selectors';
