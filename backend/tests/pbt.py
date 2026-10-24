"""Minimal seeded property-based testing helper (design: Testing Strategy).

Req 1.1 fixes the backend dependency list, so Hypothesis is not available.
``for_all`` draws examples from plain generator functions ``gen(rng) -> value``.

Determinism and replay
----------------------
Every iteration ``i`` gets its own ``random.Random(f"{seed}:{i}")``, so any single
failing example can be reproduced without re-running the earlier iterations.

- ``seed`` comes from the decorator argument, else the ``PBT_SEED`` environment
  variable, else ``DEFAULT_SEED``.
- ``PBT_RUNS`` overrides the run count of every property (handy for soak runs).
- ``PBT_REPLAY=<i>`` runs only iteration ``i`` (combine with ``PBT_SEED``).

On failure a ``PropertyFailure`` (an ``AssertionError``) is raised, chained to the
original exception, with the seed, the iteration index, the replay command and the
``repr`` of every drawn value.

Usage::

    from tests.pbt import for_all

    def gen_hb(rng):
        return round(rng.uniform(3.0, 20.0), 1)

    @for_all(gen_hb, runs=200)
    def test_hb_property(hb, db_engine):   # drawn values first, fixtures after
        ...
"""
from __future__ import annotations

import functools
import inspect
import os
import random
from typing import Any, Callable, Optional, Sequence

DEFAULT_SEED = 20250101

Generator = Callable[[random.Random], Any]


class PropertyFailure(AssertionError):
    """A property did not hold for a generated example."""


def _env_int(name: str) -> Optional[int]:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else None


def resolve_seed(seed: Optional[int] = None) -> int:
    if seed is not None:
        return seed
    env = _env_int("PBT_SEED")
    return env if env is not None else DEFAULT_SEED


def iteration_rng(seed: int, index: int) -> random.Random:
    """The rng used for iteration ``index`` of a run with ``seed`` (stable across
    processes: string seeds are hashed with SHA-512, not ``hash()``)."""
    return random.Random(f"{seed}:{index}")


def draw(gens: Sequence[Generator], seed: int, index: int) -> tuple:
    rng = iteration_rng(seed, index)
    return tuple(gen(rng) for gen in gens)


def for_all(*gens: Generator, runs: int = 100, seed: Optional[int] = None):
    """Decorator: run the test once per generated example.

    The first ``len(gens)`` parameters of the decorated function receive the drawn
    values; any remaining parameters are left to pytest as fixtures.
    """
    if not gens:
        raise TypeError("for_all needs at least one generator")

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        sig = inspect.signature(fn)
        params = list(sig.parameters.values())
        if len(params) < len(gens):
            raise TypeError(
                f"{fn.__name__} takes {len(params)} parameters but for_all has {len(gens)} generators"
            )

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> None:
            run_seed = resolve_seed(seed)
            replay = _env_int("PBT_REPLAY")
            if replay is not None:
                indices: Sequence[int] = [replay]
            else:
                total = _env_int("PBT_RUNS") or runs
                indices = range(total)
            for i in indices:
                example = draw(gens, run_seed, i)
                try:
                    fn(*example, *args, **kwargs)
                except Exception as exc:  # pytest skip/fail outcomes are BaseException
                    shown = ", ".join(repr(v) for v in example)
                    raise PropertyFailure(
                        f"property {fn.__name__} failed at iteration {i} with seed {run_seed}\n"
                        f"  replay: PBT_SEED={run_seed} PBT_REPLAY={i}\n"
                        f"  example: ({shown})\n"
                        f"  error: {type(exc).__name__}: {exc}"
                    ) from exc

        # Hide the generated parameters from pytest's fixture resolution.
        wrapper.__signature__ = sig.replace(parameters=params[len(gens):])  # type: ignore[attr-defined]
        wrapper.pbt_seed = seed  # type: ignore[attr-defined]
        wrapper.pbt_runs = runs  # type: ignore[attr-defined]
        return wrapper

    return decorator


__all__ = [
    "DEFAULT_SEED",
    "PropertyFailure",
    "draw",
    "for_all",
    "iteration_rng",
    "resolve_seed",
]
