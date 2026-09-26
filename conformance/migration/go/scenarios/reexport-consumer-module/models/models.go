// Package models re-exports the SDK's type under this service's name.
package models

import "example.com/sdk"

// Account is what this service calls a customer.
type Account = sdk.Customer
