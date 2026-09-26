# Fixtures

Each directory is a hand-trimmed copy of files from a real published SDK
release, cut down to the few declarations and methods a test needs, with
the contract beside it (`contract.json`) trimmed the same way. Nothing here
is generated for the tests; where a file is shortened, what is kept is
verbatim.

| Directory | From | Generator |
| --- | --- | --- |
| `stripe-node` | npm `stripe@17.7.0` | Stripe's own |
| `stripe-node-22` | npm `stripe@22.6.1` | Stripe's own |
| `stripe-python` | PyPI `stripe==7.14.0` | Stripe's own |
| `stainless-python` | PyPI `anthropic==0.79.0` | Stainless |
| `stainless-typescript` | npm `@anthropic-ai/sdk@0.123.0` | Stainless |
| `stainless-go` | Go `github.com/anthropics/anthropic-sdk-go@v1.69.0` | Stainless |
| `openapi-typescript` | npm `@octokit/openapi-types@29.0.1` | openapi-typescript 6 |
| `openapi-generator-python` | PyPI `ory-client==1.22.28` | openapi-generator 7.17.0 |
| `openapi-generator-typescript` | npm `@ory/client@1.22.28` (typescript-axios) | openapi-generator 7.17.0 |
| `openapi-generator-go` | Go `github.com/ory/client-go@v1.22.28` | openapi-generator 7.17.0 |
| `speakeasy-python` | PyPI `mistralai==2.10.1` | Speakeasy |
| `speakeasy-typescript` | npm `@mistralai/mistralai@2.7.0` | Speakeasy |
| `fern-python` | PyPI `cohere==7.1.1` | Fern |
| `fern-typescript` | npm `cohere-ai@8.1.0` | Fern |
