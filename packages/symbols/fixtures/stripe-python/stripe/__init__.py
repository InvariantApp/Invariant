from typing_extensions import TYPE_CHECKING, Literal
from typing import Optional
import sys as _sys
import os

from stripe._api_version import _ApiVersion

from stripe._stripe_object import StripeObject as StripeObject
from stripe._api_resource import APIResource as APIResource

# Namespaces
from stripe import (
    checkout as checkout,
)

# The beginning of the section generated from our OpenAPI spec
from stripe._invoice_line_item import InvoiceLineItem as InvoiceLineItem
from stripe._line_item import LineItem as LineItem
from stripe._subscription import Subscription as Subscription
