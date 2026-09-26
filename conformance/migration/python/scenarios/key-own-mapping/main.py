# The consumer's own typed mapping has an entry with the field's name.
import acme

client = acme.Client("sk_test")

LABELS: dict[str, str] = {"nickname": "Nickname", "email": "Email"}


def heading(id: str) -> str:
    customer = client.customers.retrieve(id)
    return ": ".join([LABELS["nickname"], customer.id])
