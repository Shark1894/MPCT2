"""Endgame studies (Training tab): importing a PGN file of studies, browsing them by material,
stipulation and progress, solving them, and favourites (like bookmarked lines).

A study is matched by its start position and solution, so importing the same file (or a bigger
collection that contains it) again updates the studies already there and keeps your progress;
a study whose moves changed is a different study.
"""

from datetime import datetime, timezone

from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.chessable import CourseLine
from app.core.pgn_course import MATERIAL, NotACourse, parse_course
from app.db.models import EndgameStudy
from app.repositories.repertoire import NotFound

GROUPS = tuple(MATERIAL)  # pawn, minor, rook, rook_minor, queen, many (in this order)
GROUP_TITLES = {k: title for k, (_, title) in MATERIAL.items()}
STATUSES = ("new", "solved", "missed")
NOTE_MAX = 500
IMPORT_MAX = 150_000  # studies in one file (HHdbVII has about 103k)
LIST_MAX = 200
QUEUE_MAX = 500


class InvalidStudies(ValueError):
    pass


def _study(s: Session, study_id: int) -> EndgameStudy:
    st = s.get(EndgameStudy, study_id)
    if st is None:
        raise NotFound(f"Study {study_id} not found")
    return st


# ---- import ------------------------------------------------------------------------------------


def parse(text: str) -> tuple[list[CourseLine], list[str]]:
    try:
        parsed = parse_course(text, "", "material")
    except NotACourse as exc:
        raise InvalidStudies(str(exc)) from exc
    if len(parsed.lines) > IMPORT_MAX:
        raise InvalidStudies(f"{len(parsed.lines):,} studies is more than one import takes ({IMPORT_MAX:,})")
    return parsed.lines, parsed.skipped


def preview(text: str) -> dict:
    lines, skipped = parse(text)
    counts = {g: 0 for g in GROUPS}
    for line in lines:
        counts[line.meta["group"]] += 1
    return {
        "studies": len(lines),
        "groups": [{"group": g, "title": GROUP_TITLES[g], "count": n} for g, n in counts.items() if n],
        "skipped": skipped,
    }


def import_studies(s: Session, text: str, collection: str, groups: list[str] | None = None) -> dict:
    """Add the file's studies (only these material groups, if given); update the ones already there."""
    collection = collection.strip()[:100]
    if not collection:
        raise InvalidStudies("Give the collection a name")
    lines, skipped = parse(text)
    if groups is not None:
        unknown = set(groups) - set(GROUPS)
        if unknown:
            raise InvalidStudies(f"Unknown material group {sorted(unknown)[0]!r}")
        lines = [line for line in lines if line.meta["group"] in groups]
    if not lines:
        raise InvalidStudies("No studies chosen: tick at least one group")
    keys = [line.line_id for line in lines]
    existing: dict[int, EndgameStudy] = {}
    for i in range(0, len(keys), 5000):
        existing |= {st.key: st for st in s.scalars(select(EndgameStudy).where(EndgameStudy.key.in_(keys[i : i + 5000])))}
    start = (s.scalar(select(func.max(EndgameStudy.position)).where(EndgameStudy.collection == collection)) or 0) + 1
    report = {"collection": collection, "added": 0, "updated": 0, "unchanged": 0, "skipped": skipped}
    new_rows = []
    for n, line in enumerate(lines):
        m = line.meta
        values = {
            "title": line.title[:200],
            "composer": m["composer"][:200],
            "year": m["year"],
            "source": m["source"][:200],
            "stipulation": m["stipulation"],
            "material": m["material"][:60],
            "material_group": m["group"],
            "pieces": m["pieces"],
            "color": line.color,
            "start_fen": line.start_fen,
            "ucis": " ".join(line.ucis),
            "sans": " ".join(line.sans),
            "comments": {str(k): v for k, v in line.comments.items()},
        }
        st = existing.get(line.line_id)
        if st is None:
            new_rows.append(EndgameStudy(key=line.line_id, collection=collection, position=start + n, **values))
            report["added"] += 1
            continue
        changed = any(getattr(st, k) != v for k, v in values.items())
        for k, v in values.items():
            setattr(st, k, v)
        report["updated" if changed else "unchanged"] += 1
    s.add_all(new_rows)
    s.flush()
    return report


def delete_collection(s: Session, collection: str) -> int:
    """Remove every study of a collection (progress and favourites with them). Returns how many."""
    n = s.execute(delete(EndgameStudy).where(EndgameStudy.collection == collection)).rowcount
    if not n:
        raise NotFound(f"No collection called '{collection}'")
    s.flush()
    return n


# ---- reading -----------------------------------------------------------------------------------


def summary(s: Session) -> dict:
    """Counts for the hub and the page's filters: by material group (with progress), favourites,
    stipulations and collections."""
    groups = {g: {"group": g, "title": GROUP_TITLES[g], "total": 0, "new": 0, "solved": 0, "missed": 0} for g in GROUPS}
    for g, status, n in s.execute(
        select(EndgameStudy.material_group, EndgameStudy.status, func.count()).group_by(EndgameStudy.material_group, EndgameStudy.status)
    ):
        if g in groups:
            groups[g][status] = n
            groups[g]["total"] += n
    total = {k: sum(g[k] for g in groups.values()) for k in ("total", "new", "solved", "missed")}
    favourites = s.scalar(select(func.count()).where(EndgameStudy.favourited_at.is_not(None))) or 0
    stips = dict(s.execute(select(EndgameStudy.stipulation, func.count()).group_by(EndgameStudy.stipulation)).all())
    collections = [
        {"name": name, "count": n}
        for name, n in s.execute(
            select(EndgameStudy.collection, func.count()).group_by(EndgameStudy.collection).order_by(func.min(EndgameStudy.created_at))
        )
    ]
    return {**total, "favourites": favourites, "wins": stips.get("win", 0), "draws": stips.get("draw", 0),
            "groups": [g for g in groups.values() if g["total"]], "collections": collections}


def _filtered(group=None, stipulation=None, status=None, favourites=False, q=None, collection=None):
    query = select(EndgameStudy)
    if group:
        query = query.where(EndgameStudy.material_group == group)
    if stipulation:
        query = query.where(EndgameStudy.stipulation == stipulation)
    if status == "unsolved":
        query = query.where(EndgameStudy.status != "solved")
    elif status:
        query = query.where(EndgameStudy.status == status)
    if favourites:
        query = query.where(EndgameStudy.favourited_at.is_not(None))
    if collection:
        query = query.where(EndgameStudy.collection == collection)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(or_(EndgameStudy.title.ilike(like), EndgameStudy.composer.ilike(like),
                                EndgameStudy.source.ilike(like), EndgameStudy.material.ilike(like)))
    return query


GROUP_ORDER = case({g: i for i, g in enumerate(GROUPS)}, value=EndgameStudy.material_group)


def _brief(st: EndgameStudy) -> dict:
    return {"id": st.id, "title": st.title, "composer": st.composer, "year": st.year, "source": st.source,
            "stipulation": st.stipulation, "material": st.material, "group": st.material_group, "color": st.color,
            "start_fen": st.start_fen, "moves": len(st.ucis.split()) if st.ucis else 0, "status": st.status,
            "attempts": st.attempts, "favourite": st.favourited_at is not None, "favourite_note": st.favourite_note,
            "collection": st.collection}


def list_studies(s: Session, offset: int = 0, limit: int = 50, **filters) -> dict:
    """One page of studies matching the filters (by material group, then file order) and the total.
    Favourites are listed most recent first."""
    query = _filtered(**filters)
    total = s.scalar(select(func.count()).select_from(query.subquery())) or 0
    order = ((EndgameStudy.favourited_at.desc(),) if filters.get("favourites") else ()) + (GROUP_ORDER, EndgameStudy.collection, EndgameStudy.position, EndgameStudy.id)
    rows = s.scalars(query.order_by(*order).offset(max(offset, 0)).limit(min(max(limit, 1), LIST_MAX)))
    return {"total": total, "items": [_brief(st) for st in rows]}


def queue(s: Session, limit: int = 50, random: bool = False, **filters) -> list[int]:
    """Study ids to solve: new ones first, then missed, then solved (or shuffled with random)."""
    query = _filtered(**filters).with_only_columns(EndgameStudy.id)
    if random:
        query = query.order_by(func.random())
    else:
        rank = case({"new": 0, "missed": 1}, value=EndgameStudy.status, else_=2)
        query = query.order_by(rank, GROUP_ORDER, EndgameStudy.collection, EndgameStudy.position, EndgameStudy.id)
    return list(s.scalars(query.limit(min(max(limit, 1), QUEUE_MAX))))


def get_study(s: Session, study_id: int) -> dict:
    """A study in the shape of a course exercise (so it's solved the same way)."""
    st = _study(s, study_id)
    stip = {"win": "win", "draw": "draw"}.get(st.stipulation, "")
    return {
        **_brief(st),
        "course": "Endgame studies",
        "chapter": " · ".join(x for x in (GROUP_TITLES.get(st.material_group, ""), {"win": "Win", "draw": "Draw"}.get(stip, "")) if x),
        "kind": "line",
        "ucis": st.ucis.split() if st.ucis else [],
        "sans": st.sans.split() if st.sans else [],
        "comments": {int(k): v for k, v in (st.comments or {}).items()},
        "solved_count": st.solved_count,
    }


# ---- progress and favourites -------------------------------------------------------------------


def record_attempt(s: Session, study_id: int, solved: bool) -> dict:
    st = _study(s, study_id)
    st.attempts += 1
    if solved:
        st.solved_count += 1
    st.status = "solved" if solved else "missed"
    st.last_attempt_at = datetime.now(timezone.utc)
    s.flush()
    return {"id": st.id, "status": st.status, "attempts": st.attempts, "solved_count": st.solved_count}


def set_favourite(s: Session, study_id: int, note: str | None = None) -> dict:
    """Favourite a study (or change its note). Favouriting again keeps the original date."""
    st = _study(s, study_id)
    if st.favourited_at is None:
        st.favourited_at = datetime.now(timezone.utc)
    if note is not None:
        st.favourite_note = note.strip()[:NOTE_MAX]
    s.flush()
    return {"id": st.id, "favourite": True, "favourite_note": st.favourite_note}


def clear_favourite(s: Session, study_id: int) -> dict:
    st = _study(s, study_id)
    st.favourited_at = None
    st.favourite_note = ""
    s.flush()
    return {"id": st.id, "favourite": False, "favourite_note": ""}

