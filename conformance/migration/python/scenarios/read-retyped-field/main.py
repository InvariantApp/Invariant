# A field that is now RFC 3339 text, read and used as epoch seconds.
import acme

client = acme.Client("sk_test")


def age_in_days(id: str, now: int) -> float:
    customer = client.customers.retrieve(id)
    return (now - customer.created) / 86400  # <- flag
