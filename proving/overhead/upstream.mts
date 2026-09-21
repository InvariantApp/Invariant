/**
 * The provider's API for the overhead measurement: one list of payments of a
 * stated size, answered as fast as Node can, in its own process so it never
 * shares an event loop with the proxy or the client.
 *
 *   node --import tsx proving/overhead/upstream.mts <items>
 *
 * Prints its URL once it listens.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const items = Number(process.argv[2] ?? 40);
const body = JSON.stringify({
  object: "list",
  data: Array.from({ length: items }, (_, index) => ({
    id: `pay_${index}`,
    object: "payment",
    amount_cents: 4999 + index,
    currency: "usd",
    status: "succeeded",
    description: "A description of roughly the length a real one has",
    created: 1_760_000_000 + index,
  })),
  has_more: false,
});

const server = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});
server.keepAliveTimeout = 65_000;
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(
    `http://127.0.0.1:${(server.address() as AddressInfo).port} ${Buffer.byteLength(body)}\n`,
  );
});
