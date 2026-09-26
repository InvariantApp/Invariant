# A renamed field assigned on an SDK object the consumer holds.
import acme

client = acme.Client("sk_test")


def rename(id: str, name: str) -> acme.Customer:
    customer = client.customers.retrieve(id)
    customer.nickname = name
    return customer
