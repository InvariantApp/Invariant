package consumer

import "example.com/sdk"

// Label is a comment saying name.
func Label(name string) *sdk.IssueComment {
	return &sdk.IssueComment{Body: sdk.String(name)}
}

// First is the first ID.
func First() *int64 {
	return sdk.Int64(1)
}

// Pages is how many pages there are.
func Pages() *int {
	return sdk.Int(2)
}
