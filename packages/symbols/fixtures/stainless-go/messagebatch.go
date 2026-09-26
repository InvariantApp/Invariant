// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

package anthropic

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/anthropics/anthropic-sdk-go/internal/requestconfig"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// MessageBatchService contains methods and other services that help with
// interacting with the anthropic API.
type MessageBatchService struct {
	Options []option.RequestOption
}

// Send a batch of Message creation requests.
func (r *MessageBatchService) New(ctx context.Context, params MessageBatchNewParams, opts ...option.RequestOption) (res *MessageBatch, err error) {
	opts = slices.Concat(r.Options, opts)
	path := "v1/messages/batches"
	err = requestconfig.ExecuteNewRequest(ctx, http.MethodPost, path, params, &res, opts...)
	return res, err
}

// This endpoint is idempotent and can be used to poll for Message Batch
// completion. To access the results of a Message Batch, make a request to the
// `results_url` field in the response.
func (r *MessageBatchService) Get(ctx context.Context, messageBatchID string, opts ...option.RequestOption) (res *MessageBatch, err error) {
	opts = slices.Concat(r.Options, opts)
	if messageBatchID == "" {
		err = errors.New("missing required message_batch_id parameter")
		return nil, err
	}
	path := fmt.Sprintf("v1/messages/batches/%s", messageBatchID)
	err = requestconfig.ExecuteNewRequest(ctx, http.MethodGet, path, nil, &res, opts...)
	return res, err
}

type MessageBatch struct {
	// Unique object identifier.
	//
	// The format and length of IDs may change over time.
	ID string `json:"id" api:"required"`
	// RFC 3339 datetime string representing the time at which the Message Batch was
	// archived and its results became unavailable.
	ArchivedAt time.Time `json:"archived_at" api:"required" format:"date-time"`
	// RFC 3339 datetime string representing the time at which the Message Batch was
	// created.
	CreatedAt time.Time `json:"created_at" api:"required" format:"date-time"`
	// Processing status of the Message Batch.
	//
	// Any of "in_progress", "canceling", "ended".
	ProcessingStatus MessageBatchProcessingStatus `json:"processing_status" api:"required"`
	// Object type.
	//
	// For Message Batches, this is always `"message_batch"`.
	Type constant.MessageBatch `json:"type" default:"message_batch"`
}
