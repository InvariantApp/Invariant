package consumer

import (
	"context"

	"example.com/sdk"
)

// reactionsPage lists one page of a user's reactions.
func reactionsPage(client *sdk.Client, user string, page int) ([]string, error) {
	opts := sdk.ReactionsOptions{
		User: user,
		Page: page,
	}
	return client.Issues.ListReactions(context.Background(), opts)
}

// FirstReactions lists the first page.
func FirstReactions(client *sdk.Client, user string) ([]string, error) {
	return reactionsPage(client, user, 1)
}
