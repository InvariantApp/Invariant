package consumer

import (
	"context"

	"example.com/sdk"
)

// Comments is the consumer's seam over the SDK's comments.
type Comments interface {
	EditComment(ctx context.Context, owner, repo string, id int64, comment *sdk.IssueComment) error
}

type commentsAPI struct{ client *sdk.Client }

func (c *commentsAPI) EditComment(ctx context.Context, owner, repo string, id int64, comment *sdk.IssueComment) error {
	_, err := c.client.Issues.EditComment(ctx, owner, repo, id, comment)
	return err
}

// fakeComments stands in for the SDK in tests, as generated mocks do.
type fakeComments struct{ edited []*sdk.IssueComment }

func (f *fakeComments) EditComment(ctx context.Context, owner, repo string, id int64, comment *sdk.IssueComment) error {
	f.edited = append(f.edited, comment)
	return nil
}

// Touch rewrites a comment as it is.
func Touch(ctx context.Context, comments Comments, comment *sdk.IssueComment) error {
	return comments.EditComment(ctx, "o", "r", 1, comment)
}
