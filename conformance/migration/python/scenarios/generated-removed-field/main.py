# A removed field read through pydantic models generated from the contract.
from typing import Optional

from acme.generated.models import Customer


def fax_of(customer: Customer) -> Optional[str]:
    return customer.fax  # <- flag
