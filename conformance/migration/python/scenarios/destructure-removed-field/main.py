# A removed field unpacked into a local.
import acme


def reachable(customer: acme.Customer) -> list[str]:
    fax, email = customer.fax, customer.email  # <- flag
    return [email] if fax is None else [email, fax]
