# Messages

Params Types:

- <a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageParam">MessageParam</a>

Response Types:

- <a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#Message">Message</a>

Methods:

- <code title="post /v1/messages">client.Messages.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageService.New">New</a>(ctx <a href="https://pkg.go.dev/context">context</a>.<a href="https://pkg.go.dev/context#Context">Context</a>, params <a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageNewParams">MessageNewParams</a>) (\*<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#Message">Message</a>, <a href="https://pkg.go.dev/builtin#error">error</a>)</code>

## Batches

Methods:

- <code title="post /v1/messages/batches">client.Messages.Batches.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageBatchService.New">New</a>(ctx <a href="https://pkg.go.dev/context">context</a>.<a href="https://pkg.go.dev/context#Context">Context</a>, params <a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageBatchNewParams">MessageBatchNewParams</a>) (\*<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageBatch">MessageBatch</a>, <a href="https://pkg.go.dev/builtin#error">error</a>)</code>
- <code title="get /v1/messages/batches/{message_batch_id}">client.Messages.Batches.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageBatchService.Get">Get</a>(ctx <a href="https://pkg.go.dev/context">context</a>.<a href="https://pkg.go.dev/context#Context">Context</a>, messageBatchID <a href="https://pkg.go.dev/builtin#string">string</a>) (\*<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go">anthropic</a>.<a href="https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go#MessageBatch">MessageBatch</a>, <a href="https://pkg.go.dev/builtin#error">error</a>)</code>
