// Another of the SDK's types, which no Change touches, has a field of the same
// name.
package scenario

import (
	"context"

	"example.com/sdk"
)

// MerchantName is a merchant's name.
func MerchantName(ctx context.Context, client *sdk.Client, id string) (string, error) {
	merchant, err := client.Merchants.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return merchant.Nickname, nil
}
