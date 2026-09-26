# The consumer's own module, re-exporting the SDK's class under its name.
from acme import Customer as Account

__all__ = ["Account"]
