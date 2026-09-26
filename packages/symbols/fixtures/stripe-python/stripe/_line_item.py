# -*- coding: utf-8 -*-
# File generated from our OpenAPI spec
from stripe._stripe_object import StripeObject
from typing import ClassVar, List, Optional
from typing_extensions import Literal, TYPE_CHECKING


class LineItem(StripeObject):
    """
    A line item.
    """

    OBJECT_NAME: ClassVar[Literal["item"]] = "item"

    amount_discount: int
    """
    Total discount amount applied. If no discounts were applied, defaults to 0.
    """
    amount_subtotal: int
    """
    Total before any discounts or taxes are applied.
    """
    amount_total: int
    """
    Total after discounts and taxes.
    """
    currency: str
    """
    Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
    """
    id: str
    """
    Unique identifier for the object.
    """
    object: Literal["item"]
    """
    String representing the object's type. Objects of the same type share the same value.
    """
