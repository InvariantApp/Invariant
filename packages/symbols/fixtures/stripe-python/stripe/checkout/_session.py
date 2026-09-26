# -*- coding: utf-8 -*-
# File generated from our OpenAPI spec
from stripe import _util
from stripe._createable_api_resource import CreateableAPIResource
from stripe._expandable_field import ExpandableField
from stripe._stripe_object import StripeObject
from typing import ClassVar, Dict, List, Optional, cast, overload
from typing_extensions import (
    Literal,
    NotRequired,
    TypedDict,
    Unpack,
    TYPE_CHECKING,
)

if TYPE_CHECKING:
    from stripe._line_item import LineItem


class Session(
    CreateableAPIResource["Session"],
):
    """
    A Checkout Session represents your customer's session as they pay for
    one-time purchases or subscriptions through [Checkout](https://stripe.com/docs/payments/checkout)
    or [Payment Links](https://stripe.com/docs/payments/payment-links). We recommend creating a
    new Session each time your customer attempts to pay.
    """

    OBJECT_NAME: ClassVar[Literal["checkout.session"]] = "checkout.session"

    class AutomaticTax(StripeObject):
        enabled: bool
        """
        Indicates whether automatic tax is enabled for the session
        """
        status: Optional[
            Literal["complete", "failed", "requires_location_inputs"]
        ]
        """
        The status of the most recent automated tax calculation for this session.
        """

    amount_subtotal: Optional[int]
    """
    Total of all items before discounts or taxes are applied.
    """
    amount_total: Optional[int]
    """
    Total of all items after discounts and taxes are applied.
    """
    automatic_tax: AutomaticTax
    id: str
    """
    Unique identifier for the object.
    """
    object: Literal["checkout.session"]
    """
    String representing the object's type. Objects of the same type share the same value.
    """
    _inner_class_types = {
        "automatic_tax": AutomaticTax,
    }
