# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["TextBlock"]


class TextBlock(BaseModel):
    citations: Optional[List[object]] = None
    """Citations supporting the text block."""

    text: str

    type: Literal["text"]
