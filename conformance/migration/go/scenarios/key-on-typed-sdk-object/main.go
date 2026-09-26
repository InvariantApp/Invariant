// The renamed field read by name, through reflection, from the SDK's struct.
package scenario

import (
	"reflect"

	"example.com/sdk"
)

// NameOf is a customer's name.
func NameOf(customer *sdk.Customer) string {
	return reflect.ValueOf(customer).Elem().FieldByName("Nickname").String()
}
