# The response copied to another local, the renamed field read through it.
import acme

client = acme.Client("sk_test")


def name_of(id: str) -> str:
    customer = client.customers.retrieve(id)
    current = customer
    return current.nickname
