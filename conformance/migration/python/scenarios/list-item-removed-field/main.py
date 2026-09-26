# A field the response's list items lost.
import acme


def fingerprints(customer: acme.Customer) -> list[str]:
    return [card.fingerprint for card in customer.cards]  # <- flag
