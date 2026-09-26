# A renamed field of a list item, read in a comprehension over the list.
import acme


def digits(customer: acme.Customer) -> list[str]:
    return [card.last4 for card in customer.cards]
