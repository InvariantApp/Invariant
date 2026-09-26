# A test's stand-in for a response, built as the SDK's class, holding a
# field whose encoding changed.
import acme


def fake_customer() -> acme.Customer:
    customer = acme.Customer()
    customer.id = "cus_1"
    customer.created = 1700000000  # <- flag
    return customer
