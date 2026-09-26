# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from .._utils import PropertyInfo
from .text_block import TextBlock

__all__ = ["ContentBlock"]

ContentBlock: TypeAlias = Annotated[
    Union[TextBlock],
    PropertyInfo(discriminator="type"),
]
