# The renamed field read from a response that may be None.
from typing import Optional

import acme


def label(customer: Optional[acme.Customer]) -> Optional[str]:
    return customer.nickname if customer is not None else None
