// A consumer that never adopted TypeScript: the SDK's types still reach it.
const Pay = require("paysdk");

module.exports.client = new Pay("sk_test", { apiVersion: '2023-10-16' });
