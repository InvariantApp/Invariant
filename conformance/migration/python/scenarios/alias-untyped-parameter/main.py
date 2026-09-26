# The response passed through a parameter nobody annotated; every caller
# passes the SDK's object.
import acme

client = acme.Client("sk_test")


def label(customer):
    return customer.nickname


def show(id: str) -> str:
    return label(client.customers.retrieve(id))
