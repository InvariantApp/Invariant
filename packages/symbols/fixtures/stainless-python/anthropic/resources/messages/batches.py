# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable

import httpx

from ... import _legacy_response
from ..._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ..._utils import maybe_transform, async_maybe_transform
from ..._resource import SyncAPIResource, AsyncAPIResource
from ..._base_client import AsyncPaginator, make_request_options
from ...types.messages import batch_list_params, batch_create_params

__all__ = ["Batches", "AsyncBatches"]


class Batches(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> BatchesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.
        """
        return BatchesWithRawResponse(self)

    def create(
        self,
        *,
        requests: Iterable[batch_create_params.Request],
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MessageBatch:
        """
        Send a batch of Message creation requests.

        Args:
          requests: List of requests for prompt completion. Each is an individual request to create
              a Message.
        """
        return self._post(
            "/v1/messages/batches",
            body=maybe_transform({"requests": requests}, batch_create_params.BatchCreateParams),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=MessageBatch,
        )

    def retrieve(
        self,
        message_batch_id: str,
        *,
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MessageBatch:
        """
        This endpoint is idempotent and can be used to poll for Message Batch
        completion.
        """
        if not message_batch_id:
            raise ValueError(f"Expected a non-empty value for `message_batch_id` but received {message_batch_id!r}")
        return self._get(
            f"/v1/messages/batches/{message_batch_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=MessageBatch,
        )


class AsyncBatches(AsyncAPIResource):
    async def create(
        self,
        *,
        requests: Iterable[batch_create_params.Request],
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MessageBatch:
        """
        Send a batch of Message creation requests.
        """
        return await self._post(
            "/v1/messages/batches",
            body=await async_maybe_transform({"requests": requests}, batch_create_params.BatchCreateParams),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=MessageBatch,
        )


class BatchesWithRawResponse:
    def __init__(self, batches: Batches) -> None:
        self._batches = batches

        self.create = _legacy_response.to_raw_response_wrapper(
            batches.create,
        )
