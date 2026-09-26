# A renamed enum value compared with the response's field.
import acme


def is_live(customer: acme.Customer) -> bool:
    return customer.status == "active"
