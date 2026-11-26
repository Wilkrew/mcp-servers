"""Retrieval evals for the heinel-dev search tool (this package and heinel.dev/mcp).

Sends every question in golden.json to the MCP endpoint's search tool, the
way an AI agent would, and scores the results:

- hit@1 and hit@k: the share of positive questions with a relevant chunk
  first, or anywhere in the top k results;
- MRR: the mean of 1 / rank of the first relevant chunk (0 when none of the
  results is relevant);
- negatives: the share of questions that should find nothing and do.

Usage:
    python3 evals/search/run.py                          # http://localhost:3333/mcp (npm run serve)
    python3 evals/search/run.py --url https://heinel.dev/mcp --delay 1.2
    python3 evals/search/run.py --markdown report.md --json results.json

It exits with 1 when a score is below the gate in golden.json, and with 2
when the endpoint can't be reached. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
PROTOCOL = "2025-06-18"
KINDS = ("keyword", "question", "swedish", "negative")


@dataclass
class Question:
    id: str
    kind: str
    query: str
    relevant: list[str]
    note: str = ""

    @property
    def negative(self) -> bool:
        return self.kind == "negative"


@dataclass
class Outcome:
    question: Question
    results: list[dict[str, Any]]
    rank: int | None = None  # 1-based rank of the first relevant result
    passed: bool = False


@dataclass
class Scores:
    positives: int = 0
    negatives: int = 0
    hit_at_1: float = 0.0
    hit_at_k: float = 0.0
    mrr: float = 0.0
    negatives_passed: float = 0.0
    by_kind: dict[str, dict[str, float]] = field(default_factory=dict)


def load_golden(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    for q in data["questions"]:
        if q["id"] in seen:
            raise ValueError(f"duplicate question id: {q['id']}")
        seen.add(q["id"])
        if q["kind"] not in KINDS:
            raise ValueError(f"{q['id']}: unknown kind {q['kind']!r}")
        if (q["kind"] == "negative") != (not q["relevant"]):
            raise ValueError(f"{q['id']}: negatives have no relevant chunks, and only negatives")
    return data


def questions_from(data: dict[str, Any]) -> list[Question]:
    return [
        Question(q["id"], q["kind"], q["query"], list(q["relevant"]), q.get("note", ""))
        for q in data["questions"]
    ]


def first_relevant_rank(result_ids: list[str], relevant: list[str]) -> int | None:
    wanted = set(relevant)
    for i, rid in enumerate(result_ids, start=1):
        if rid in wanted:
            return i
    return None


def judge(question: Question, results: list[dict[str, Any]], k: int) -> Outcome:
    if question.negative:
        return Outcome(question, results, None, passed=not results)
    rank = first_relevant_rank([r["id"] for r in results], question.relevant)
    return Outcome(question, results, rank, passed=rank is not None and rank <= k)


def score(outcomes: list[Outcome], k: int) -> Scores:
    def summarise(group: list[Outcome]) -> dict[str, float]:
        pos = [o for o in group if not o.question.negative]
        neg = [o for o in group if o.question.negative]
        out: dict[str, float] = {"count": float(len(group))}
        if pos:
            out["hit_at_1"] = sum(o.rank == 1 for o in pos) / len(pos)
            out["hit_at_k"] = sum(o.rank is not None and o.rank <= k for o in pos) / len(pos)
            out["mrr"] = sum(1 / o.rank for o in pos if o.rank) / len(pos)
        if neg:
            out["negatives"] = sum(o.passed for o in neg) / len(neg)
        return out

    total = summarise(outcomes)
    s = Scores(
        positives=sum(not o.question.negative for o in outcomes),
        negatives=sum(o.question.negative for o in outcomes),
        hit_at_1=total.get("hit_at_1", 0.0),
        hit_at_k=total.get("hit_at_k", 0.0),
        mrr=total.get("mrr", 0.0),
        negatives_passed=total.get("negatives", 1.0),
    )
    for kind in KINDS:
        group = [o for o in outcomes if o.question.kind == kind]
        if group:
            s.by_kind[kind] = summarise(group)
    return s


def gate_failures(s: Scores, gate: dict[str, float], k: int) -> list[str]:
    actual = {f"hit_at_{k}": s.hit_at_k, "hit_at_1": s.hit_at_1, "mrr": s.mrr, "negatives": s.negatives_passed}
    failures = []
    for name, minimum in gate.items():
        if name not in actual:
            raise ValueError(f"unknown gate {name!r}; use one of {', '.join(actual)}")
        if actual[name] + 1e-9 < minimum:
            failures.append(f"{name} {actual[name]:.2f} is below the gate of {minimum:.2f}")
    return failures


class McpClient:
    """A minimal client for a stateless Streamable HTTP MCP endpoint."""

    def __init__(self, url: str, timeout: float = 20.0, delay: float = 0.0,
                 opener: Callable[..., Any] = urllib.request.urlopen):
        self.url = url
        self.timeout = timeout
        self.delay = delay
        self.opener = opener
        self.next_id = 0
        self.requests = 0

    def rpc(self, method: str, params: dict[str, Any]) -> Any:
        if self.delay and self.requests:
            time.sleep(self.delay)
        self.next_id += 1
        self.requests += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        request = urllib.request.Request(
            self.url,
            data=body.encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                "mcp-protocol-version": PROTOCOL,
                "user-agent": "heinel-dev-search-evals/1",
            },
        )
        with self.opener(request, timeout=self.timeout) as response:
            raw = response.read().decode("utf-8")
            kind = response.headers.get("content-type", "")
        message = parse_message(raw, kind)
        if "error" in message:
            raise RuntimeError(f"{method}: {message['error'].get('message')}")
        return message["result"]

    def initialize(self) -> dict[str, Any]:
        return self.rpc("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "search-evals", "version": "1"},
        })

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        result = self.rpc("tools/call", {"name": "search", "arguments": {"query": query, "limit": limit}})
        if result.get("isError"):
            raise RuntimeError(f"search {query!r}: {result['content'][0]['text']}")
        return json.loads(result["content"][0]["text"])["results"]


def parse_message(raw: str, content_type: str) -> dict[str, Any]:
    """Reads a JSON-RPC reply sent as plain JSON or as one server-sent event."""
    if "text/event-stream" in content_type:
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        if not data:
            raise RuntimeError("empty event stream")
        return json.loads(data[-1])
    return json.loads(raw)


def run(client: McpClient, questions: list[Question], k: int, limit: int) -> list[Outcome]:
    client.initialize()
    return [judge(q, client.search(q.query, limit), k) for q in questions]


def pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def report_markdown(outcomes: list[Outcome], s: Scores, k: int, url: str, failures: list[str]) -> str:
    lines = [
        "## Search evals",
        "",
        f"{len(outcomes)} questions against `{url}`: {s.positives} that should find something, "
        f"{s.negatives} that shouldn't.",
        "",
        "| Score | Value |",
        "|---|---|",
        f"| hit@1 | {pct(s.hit_at_1)} |",
        f"| hit@{k} | {pct(s.hit_at_k)} |",
        f"| MRR | {s.mrr:.2f} |",
        f"| Negatives that found nothing | {pct(s.negatives_passed)} |",
        "",
        "| Kind | Questions | hit@1 | hit@" + str(k) + " | MRR | Negatives |",
        "|---|---|---|---|---|---|",
    ]
    for kind, v in s.by_kind.items():
        lines.append(
            f"| {kind} | {int(v['count'])} | "
            + " | ".join(
                pct(v[m]) if m in v and m != "mrr" else (f"{v[m]:.2f}" if m in v else "–")
                for m in ("hit_at_1", "hit_at_k", "mrr", "negatives")
            )
            + " |"
        )
    missed = [o for o in outcomes if not o.passed]
    lines += ["", f"### Misses ({len(missed)})", ""]
    if not missed:
        lines.append("None.")
    for o in missed:
        got = ", ".join(f"`{r['id']}`" for r in o.results[:k]) or "nothing"
        want = "nothing" if o.question.negative else ", ".join(f"`{r}`" for r in o.question.relevant)
        lines.append(f"- **{o.question.id}** \"{o.question.query}\": got {got}; wanted {want}.")
        if o.question.note:
            lines.append(f"  {o.question.note}")
    lines += ["", "**Gate:** " + ("passed." if not failures else "failed: " + "; ".join(failures) + ".")]
    return "\n".join(lines) + "\n"


def report_json(outcomes: list[Outcome], s: Scores, k: int, url: str) -> dict[str, Any]:
    return {
        "url": url,
        "k": k,
        "scores": {"hit_at_1": s.hit_at_1, f"hit_at_{k}": s.hit_at_k, "mrr": s.mrr,
                   "negatives": s.negatives_passed, "by_kind": s.by_kind},
        "questions": [
            {"id": o.question.id, "query": o.question.query, "passed": o.passed, "rank": o.rank,
             "results": [r["id"] for r in o.results]}
            for o in outcomes
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", default="http://localhost:3333/mcp")
    parser.add_argument("--golden", type=Path, default=HERE / "golden.json")
    parser.add_argument("--delay", type=float, default=0.0,
                        help="seconds between requests; use about 1.2 against heinel.dev, which allows 60 a minute")
    parser.add_argument("--markdown", type=Path, help="also write the report as Markdown (appends)")
    parser.add_argument("--json", type=Path, help="also write every result as JSON")
    args = parser.parse_args(argv)

    data = load_golden(args.golden)
    k, limit = int(data["k"]), int(data["limit"])
    client = McpClient(args.url, delay=args.delay)
    try:
        outcomes = run(client, questions_from(data), k, limit)
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        print(f"Can't reach {args.url}: {e}", file=sys.stderr)
        return 2

    s = score(outcomes, k)
    failures = gate_failures(s, data.get("gate", {}), k)
    text = report_markdown(outcomes, s, k, args.url, failures)
    print(text, end="")
    if args.markdown:
        with args.markdown.open("a", encoding="utf-8") as f:
            f.write(text)
    if args.json:
        args.json.write_text(json.dumps(report_json(outcomes, s, k, args.url), indent=2) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
