# The request body's field is renamed; the response's field of the same
# name is not, and is what this reads.
import acme

client = acme.Client("sk_test")


def name_of(id: str) -> str:
    customer = client.customers.retrieve(id)
    return customer.nickname
