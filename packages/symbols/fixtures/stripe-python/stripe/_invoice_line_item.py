# -*- coding: utf-8 -*-
# File generated from our OpenAPI spec
from stripe._expandable_field import ExpandableField
from stripe._stripe_object import StripeObject
from typing import ClassVar, Dict, List, Optional
from typing_extensions import Literal, TYPE_CHECKING

if TYPE_CHECKING:
    from stripe._discount import Discount


class InvoiceLineItem(StripeObject):
    OBJECT_NAME: ClassVar[Literal["line_item"]] = "line_item"

    class Period(StripeObject):
        end: int
        """
        The end of the period, which must be greater than or equal to the start. This value is inclusive.
        """
        start: int
        """
        The start of the period. This value is inclusive.
        """

    amount: int
    """
    The amount, in cents (or local equivalent).
    """
    currency: str
    """
    Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
    """
    id: str
    """
    Unique identifier for the object.
    """
    invoice: Optional[str]
    """
    The ID of the invoice that contains this line item.
    """
    object: Literal["line_item"]
    """
    String representing the object's type. Objects of the same type share the same value.
    """
    period: Period
    _inner_class_types = {"period": Period}
