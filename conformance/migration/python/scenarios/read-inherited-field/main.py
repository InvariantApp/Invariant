# A renamed field the SDK declares on the base its response class extends.
import acme

client = acme.Client("sk_test")


def email_of(id: str) -> str:
    customer = client.customers.retrieve(id)
    return customer.email
