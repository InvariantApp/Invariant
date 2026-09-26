// The consumer's own struct has a field of the same name.
package scenario

import (
	"context"

	"example.com/sdk"
)

// Profile is this service's own view of a person.
type Profile struct {
	Nickname string
}

// Greet greets a profile.
func Greet(profile Profile) string {
	return profile.Nickname
}

// ProfileOf is the profile of a customer.
func ProfileOf(ctx context.Context, client *sdk.Client, id string) (Profile, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return Profile{}, err
	}
	return Profile{Nickname: customer.ID}, nil
}
