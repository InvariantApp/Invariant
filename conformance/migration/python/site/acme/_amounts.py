from decimal import Decimal


def to_minor_units(amount: Decimal) -> int:
    """An amount in major units as the exact number of minor units."""
    ...


def from_minor_units(minor: int) -> Decimal:
    """A number of minor units as the exact amount in major units."""
    ...
