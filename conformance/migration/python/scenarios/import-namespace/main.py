# The SDK imported whole, its class named through the module.
import acme

client = acme.Client("sk_test")


def name_of(id: str) -> str:
    customer: acme.Customer = client.customers.retrieve(id)
    return customer.nickname
