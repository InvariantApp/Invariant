# An amount now in minor units, read from a response that may be None.
from decimal import Decimal
from typing import Optional

import acme


def owed(customer: Optional[acme.Customer]) -> Optional[Decimal]:
    return customer.balance if customer is not None else None  # <- flag
