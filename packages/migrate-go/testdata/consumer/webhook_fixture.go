package consumer

// A recorded webhook, as integration tests keep them: JSON in a raw string,
// with template placeholders, which nothing types.
const secretCreated = `{
  "object": "event",
  "data": {
    "object": {
      "object": "secret",
      "name": "{{ .Name }}",
      "created_at": "2024-01-01T00:00:00Z"
    }
  }
}`

var _ = secretCreated
