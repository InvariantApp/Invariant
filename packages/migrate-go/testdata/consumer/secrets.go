// Package consumer calls the SDK the ways real consumers of go-github do.
package consumer

import (
	"context"

	"example.com/sdk"
)

// Secrets is the consumer's own seam over the SDK.
type Secrets interface {
	DeleteEnvSecret(ctx context.Context, repoID int, env, name string) error
}

type api struct{ client *sdk.Client }

func (a *api) DeleteEnvSecret(ctx context.Context, repoID int, env, name string) error {
	return a.client.Actions.DeleteEnvSecret(ctx, repoID, env, name)
}

type retrying struct{ next Secrets }

func (r *retrying) DeleteEnvSecret(ctx context.Context, repoID int, env, name string) error {
	return r.next.DeleteEnvSecret(ctx, repoID, env, name)
}

// Sync removes the token from production.
func Sync(ctx context.Context, secrets Secrets, repoID int) error {
	return secrets.DeleteEnvSecret(ctx, repoID, "production", "TOKEN")
}

// Put stores the token.
func Put(ctx context.Context, client *sdk.Client, owner, repo string) error {
	secret := &sdk.EncryptedSecret{
		Name:  "TOKEN",
		KeyID: "key",
	}
	return client.Actions.CreateOrUpdateRepoSecret(ctx, owner, repo, secret)
}

// Variable creates a variable.
func Variable(ctx context.Context, client *sdk.Client) error {
	return client.Actions.CreateRepoVariable(ctx, "o", "r", sdk.VariableCreateRequest{Name: "A", Value: "b"})
}

// Names lists the secrets' names and how many there are.
func Names(ctx context.Context, client *sdk.Client) ([]string, int) {
	secrets, _ := client.Actions.ListRepoSecrets(ctx, "o", "r")
	var names []string
	total := 0
	for _, secret := range secrets {
		names = append(names, secret.Name)
		total += secret.Total
	}
	return names, total
}
