# A field that moved into a nested object, read from where it used to be.
import acme

client = acme.Client("sk_test")


def phone_of(id: str) -> str:
    customer = client.customers.retrieve(id)
    return customer.phone
