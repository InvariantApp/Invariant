# The response passed to the consumer's own function, annotated as the SDK's.
import acme

client = acme.Client("sk_test")


def label(customer: acme.Customer) -> str:
    return customer.nickname


def show(id: str) -> str:
    return label(client.customers.retrieve(id))
