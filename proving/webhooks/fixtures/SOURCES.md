# Where these payloads come from

Real payloads, not written for this project, so the proof runs on what a
provider actually sends.

- `github-issues-opened.json`: the first `issues` example with `action:
  opened` in [`@octokit/webhooks-examples`](https://github.com/octokit/webhooks)
  7.6.1, `api.github.com/index.json`. MIT License, Copyright (c) 2020 Octokit
  contributors.
- `stripe-charge.json`: the `charge` resource in
  [`stripe/openapi`](https://github.com/stripe/openapi)
  `openapi/fixtures3.json`, fetched on 2026-09-21, the object Stripe's own mock
  answers with. MIT License, Copyright (c) 2011- Stripe, Inc.
