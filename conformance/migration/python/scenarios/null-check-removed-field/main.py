# A removed field checked for None before use.
import acme


def fax_of(customer: acme.Customer) -> str:
    return customer.fax if customer.fax is not None else ""  # <- flag
