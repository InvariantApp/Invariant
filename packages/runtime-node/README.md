# @invariant/runtime-node

The Invariant runtime in any Node server: Express 4 and 5, Koa, Fastify 4 and 5, NestJS 10 to 12 on Express, a Next.js 14 to 16 custom server, or plain `node:http`. One conformance suite holds each of them to the same behaviour.

```ts
import { createServer } from "node:http";
import { createRuntime } from "@invariant/runtime";
import { adaptListener } from "@invariant/runtime-node";
import program from "./invariant/compiled/program.json" with { type: "json" };

const runtime = createRuntime({ program });
createServer(adaptListener(app, { runtime })).listen(3000); // Express: app; Koa: app.callback()
```

Fastify: `Fastify({ serverFactory: (handler) => createServer(adaptListener(handler, { runtime })) })`.

`adaptListener` runs before anything in the application. Where a middleware
checks a signature over the request body, mount `adaptMiddleware({ runtime })`
after that check instead, so it sees the bytes the caller signed.

How a request names its contract comes with the program, from `invariant.yaml`.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
