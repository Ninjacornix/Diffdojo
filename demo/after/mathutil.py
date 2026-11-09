import math


def clamp(x: int, lo: int, hi: int) -> int:
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def running_max(xs: list[int]) -> list[int]:
    out = []
    best = None
    for x in xs:
        if best is None or x > best:
            best = x
        out.append(best)
    return out


def describe(n: int) -> str:
    return f"{n}:{clamp(n, 0, 5)}"
