// Package sdk is a small SDK in go-github's shape, at its first release.
package sdk

import "context"

// Secret is a secret as the API lists it.
type Secret struct {
	Name  string `json:"name"`
	Total int    `json:"total_count"`
}

// EncryptedSecret is a secret to store; its name travels in the path.
type EncryptedSecret struct {
	Name           string `json:"-"`
	KeyID          string `json:"key_id"`
	EncryptedValue string `json:"encrypted_value"`
}

// VariableCreateRequest creates a variable.
type VariableCreateRequest struct {
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

// IssuesService is the Issues part of the API.
type IssuesService struct{}

// EditComment changes a comment.
//
//meta:operation PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
func (s *IssuesService) EditComment(ctx context.Context, owner, repo string, id int64, comment *IssueComment) (*IssueComment, error) {
	return nil, nil
}

// ActionsService is the Actions part of the API.
type ActionsService struct{}

// DeleteEnvSecret deletes an environment's secret.
//
//meta:operation DELETE /repositories/{repository_id}/environments/{environment_name}/secrets/{secret_name}
func (s *ActionsService) DeleteEnvSecret(ctx context.Context, repoID int, env, name string) error {
	return nil
}

// CreateOrUpdateRepoSecret stores a secret.
//
//meta:operation PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}
func (s *ActionsService) CreateOrUpdateRepoSecret(ctx context.Context, owner, repo string, secret *EncryptedSecret) error {
	return nil
}

// CreateRepoVariable creates a variable.
//
//meta:operation POST /repos/{owner}/{repo}/actions/variables
func (s *ActionsService) CreateRepoVariable(ctx context.Context, owner, repo string, variable VariableCreateRequest) error {
	return nil
}

// ListRepoSecrets lists a repository's secrets.
//
//meta:operation GET /repos/{owner}/{repo}/actions/secrets
func (s *ActionsService) ListRepoSecrets(ctx context.Context, owner, repo string) ([]*Secret, error) {
	return nil, nil
}
