"""Parse strictly positive item counts."""


def parse_positive_count(value: str) -> int:
    """Return a positive integer; reject zero and negative counts."""
    count = int(value)
    if count < 0:
        raise ValueError("count must be positive")
    return count
