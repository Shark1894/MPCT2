"""Glicko-2 rating for puzzles. Pure maths, no database.

Each puzzle attempt is one rated game between you and the puzzle (as Lichess does): a
solve is a win, a failure a loss. The puzzle's own rating and deviation come from the
Lichess database and don't change here.

Reference: Mark Glickman, "Example of the Glicko-2 system" (2013).
"""

import math
from dataclasses import dataclass

SCALE = 173.7178
TAU = 0.75  # how fast volatility can change (Lichess uses 0.75 for puzzles)
EPSILON = 0.000001

START_RATING = 1500.0
START_RD = 350.0
START_VOLATILITY = 0.09
MIN_RD = 45.0  # never fully certain: keeps the rating moving
MAX_RD = 350.0


@dataclass(frozen=True)
class Rating:
    rating: float = START_RATING
    rd: float = START_RD
    volatility: float = START_VOLATILITY


def _g(phi: float) -> float:
    return 1 / math.sqrt(1 + 3 * phi * phi / (math.pi * math.pi))


def expected(player: Rating, opponent_rating: float, opponent_rd: float) -> float:
    """Chance the player beats (solves) an opponent of this rating."""
    mu = (player.rating - 1500) / SCALE
    mu_j = (opponent_rating - 1500) / SCALE
    phi_j = opponent_rd / SCALE
    return 1 / (1 + math.exp(-_g(phi_j) * (mu - mu_j)))


def update(player: Rating, opponent_rating: float, opponent_rd: float, score: float) -> Rating:
    """The player's rating after one game: score 1 = solved, 0 = failed."""
    mu = (player.rating - 1500) / SCALE
    phi = player.rd / SCALE
    sigma = player.volatility
    mu_j = (opponent_rating - 1500) / SCALE
    phi_j = max(opponent_rd, 1.0) / SCALE

    g = _g(phi_j)
    e = 1 / (1 + math.exp(-g * (mu - mu_j)))
    v = 1 / (g * g * e * (1 - e))
    delta = v * g * (score - e)

    # New volatility (Illinois algorithm, step 5 of the paper)
    a = math.log(sigma * sigma)

    def f(x: float) -> float:
        ex = math.exp(x)
        return ex * (delta * delta - phi * phi - v - ex) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU)

    big_a = a
    if delta * delta > phi * phi + v:
        big_b = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * TAU) < 0:
            k += 1
        big_b = a - k * TAU
    fa, fb = f(big_a), f(big_b)
    for _ in range(100):
        if abs(big_b - big_a) <= EPSILON:
            break
        c = big_a + (big_a - big_b) * fa / (fb - fa)
        fc = f(c)
        if fc * fb <= 0:
            big_a, fa = big_b, fb
        else:
            fa /= 2
        big_b, fb = c, fc
    sigma_new = math.exp(big_a / 2)

    phi_star = math.sqrt(phi * phi + sigma_new * sigma_new)
    phi_new = 1 / math.sqrt(1 / (phi_star * phi_star) + 1 / v)
    mu_new = mu + phi_new * phi_new * g * (score - e)

    rd = min(max(phi_new * SCALE, MIN_RD), MAX_RD)
    return Rating(rating=mu_new * SCALE + 1500, rd=rd, volatility=sigma_new)
