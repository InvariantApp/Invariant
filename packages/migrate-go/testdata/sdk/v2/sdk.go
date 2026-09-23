// Package sdk is a small SDK in go-github's shape, at its second release.
package sdk

import "context"

// Secret is a secret as the API lists it; the API renamed `name`.
type Secret struct {
	SecretName string `json:"secret_name"`
	TotalCount int    `json:"total_count"`
}

// SecretRequest is a secret to store.
type SecretRequest struct {
	KeyID          string `json:"key_id"`
	EncryptedValue string `json:"encrypted_value"`
}

// CreateVariableRequest creates a variable.
type CreateVariableRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Client talks to the API.
type Client struct {
	Actions *ActionsService
	Issues  *IssuesService
}

// IssueComment is a comment as the API sends it.
type IssueComment struct {
	Body *string `json:"body"`
}

// IssueCommentRequest is a comment to write.
type IssueCommentRequest struct {
	Body string `json:"body"`
}

// IssuesService is the Issues part of the API.
type IssuesService struct{}

// UpdateComment changes a comment.
//
//meta:operation PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
func (s *IssuesService) UpdateComment(ctx context.Context, owner, repo string, id int64, comment IssueCommentRequest) (*IssueComment, error) {
	return nil, nil
}

// ActionsService is the Actions part of the API.
type ActionsService struct{}

// DeleteEnvSecret deletes an environment's secret.
//
//meta:operation DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}
func (s *ActionsService) DeleteEnvSecret(ctx context.Context, owner, repo, env, name string) error {
	return nil
}

// CreateOrUpdateRepoSecret stores a secret.
//
//meta:operation PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}
func (s *ActionsService) CreateOrUpdateRepoSecret(ctx context.Context, owner, repo, name string, body SecretRequest) error {
	return nil
}

// CreateRepoVariable creates a variable.
//
//meta:operation POST /repos/{owner}/{repo}/actions/variables
func (s *ActionsService) CreateRepoVariable(ctx context.Context, owner, repo string, variable CreateVariableRequest) error {
	return nil
}

// ListRepoSecrets lists a repository's secrets.
//
//meta:operation GET /repos/{owner}/{repo}/actions/secrets
func (s *ActionsService) ListRepoSecrets(ctx context.Context, owner, repo string) ([]*Secret, error) {
	return nil, nil
}

// Ptr returns a pointer to v.
func Ptr[T any](v T) *T { return &v }

// String returns a pointer to v.
//
// Deprecated: use Ptr instead.
//
//go:fix inline
func String(v string) *string { return Ptr(v) }

// Int64 returns a pointer to v.
//
// Deprecated: use Ptr instead.
//
//go:fix inline
func Int64(v int64) *int64 { return Ptr(v) }
