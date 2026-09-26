# The field handed to the consumer's own helper, annotated with the SDK's
# values, which compares it with a renamed value.
import acme


def is_live(status: acme.CustomerStatus) -> bool:
    return status == "active"


def live(customer: acme.Customer) -> bool:
    return is_live(customer.status)
