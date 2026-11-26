"""Tests for the eval runner, against a fake MCP endpoint (no network, no site).

    python3 -m unittest discover -s evals/search
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import run

FAKE_INDEX = {
    "terraform": [{"id": "work:affarsvarlden"}, {"id": "skills:around"}],
    "lean startup": [{"id": "profile"}, {"id": "sheet:moments:repair"}],
    "kubernetes": [],
}


class FakeMcp(BaseHTTPRequestHandler):
    """Answers initialize and tools/call search like heinel.dev/mcp does."""

    sse = False
    seen: list[dict] = []

    def do_POST(self):  # noqa: N802 (http.server's naming)
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeMcp.seen.append({"body": body, "accept": self.headers.get("accept")})
        if body["method"] == "initialize":
            result = {"serverInfo": {"name": "fake"}}
        elif body["params"]["arguments"]["query"] == "broken":
            result = {"isError": True, "content": [{"type": "text", "text": "Bad input"}]}
        else:
            hits = FAKE_INDEX.get(body["params"]["arguments"]["query"].lower(), [])
            result = {"content": [{"type": "text", "text": json.dumps({"results": hits})}]}
        payload = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
        if FakeMcp.sse:
            data, kind = f"event: message\ndata: {payload}\n\n", "text/event-stream"
        else:
            data, kind = payload, "application/json"
        self.send_response(200)
        self.send_header("content-type", kind)
        self.end_headers()
        self.wfile.write(data.encode())

    def log_message(self, *args):
        pass


class WithServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), FakeMcp)
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}/mcp"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        FakeMcp.sse = False
        FakeMcp.seen = []


class ClientTest(WithServer):
    def test_search_sends_mcp_headers_and_reads_results(self):
        client = run.McpClient(self.url)
        client.initialize()
        self.assertEqual([r["id"] for r in client.search("Terraform", 5)], ["work:affarsvarlden", "skills:around"])
        self.assertIn("text/event-stream", FakeMcp.seen[0]["accept"])
        self.assertEqual(FakeMcp.seen[1]["body"]["params"], {"name": "search", "arguments": {"query": "Terraform", "limit": 5}})

    def test_reads_server_sent_events(self):
        FakeMcp.sse = True
        self.assertEqual(run.McpClient(self.url).search("kubernetes", 5), [])

    def test_tool_error_raises(self):
        with self.assertRaises(RuntimeError):
            run.McpClient(self.url).search("broken", 5)

    def test_run_judges_every_question(self):
        qs = [
            run.Question("a", "keyword", "Terraform", ["work:affarsvarlden"]),
            run.Question("b", "keyword", "Lean startup", ["sheet:moments:repair"]),
            run.Question("c", "negative", "Kubernetes", []),
        ]
        outcomes = run.run(run.McpClient(self.url), qs, k=1, limit=5)
        self.assertEqual([(o.rank, o.passed) for o in outcomes], [(1, True), (2, False), (None, True)])

    def test_main_exits_2_when_unreachable(self):
        self.assertEqual(run.main(["--url", "http://127.0.0.1:9/mcp"]), 2)


class ScoringTest(unittest.TestCase):
    def outcome(self, kind, rank=None, results=()):
        q = run.Question("x", kind, "q", [] if kind == "negative" else ["want"])
        return run.Outcome(q, list(results), rank, passed=(not results) if kind == "negative" else rank is not None and rank <= 3)

    def test_first_relevant_rank(self):
        self.assertEqual(run.first_relevant_rank(["a", "b", "c"], ["c", "b"]), 2)
        self.assertIsNone(run.first_relevant_rank(["a"], ["z"]))

    def test_judge_uses_k(self):
        q = run.Question("x", "keyword", "q", ["c"])
        results = [{"id": i} for i in "abcd"]
        self.assertTrue(run.judge(q, results, k=3).passed)
        self.assertFalse(run.judge(q, results, k=2).passed)

    def test_scores(self):
        outcomes = [
            self.outcome("keyword", 1),
            self.outcome("keyword", 2),
            self.outcome("question", None),
            self.outcome("question", 4),
            self.outcome("negative", results=[]),
            self.outcome("negative", results=[{"id": "noise"}]),
        ]
        s = run.score(outcomes, k=3)
        self.assertEqual((s.positives, s.negatives), (4, 2))
        self.assertAlmostEqual(s.hit_at_1, 1 / 4)
        self.assertAlmostEqual(s.hit_at_k, 2 / 4)
        self.assertAlmostEqual(s.mrr, (1 + 1 / 2 + 0 + 1 / 4) / 4)
        self.assertAlmostEqual(s.negatives_passed, 1 / 2)
        self.assertAlmostEqual(s.by_kind["keyword"]["hit_at_k"], 1.0)

    def test_gate(self):
        s = run.Scores(hit_at_1=0.5, hit_at_k=0.9, mrr=0.7, negatives_passed=1.0)
        self.assertEqual(run.gate_failures(s, {"hit_at_3": 0.9, "negatives": 1.0}, 3), [])
        self.assertEqual(len(run.gate_failures(s, {"hit_at_3": 0.95, "mrr": 0.8}, 3)), 2)
        with self.assertRaises(ValueError):
            run.gate_failures(s, {"recall": 0.5}, 3)


class GoldenTest(unittest.TestCase):
    def test_golden_file_is_valid(self):
        data = run.load_golden(Path(run.HERE / "golden.json"))
        qs = run.questions_from(data)
        self.assertGreaterEqual(len(qs), 40)
        self.assertTrue(all(q.query.strip() for q in qs))
        self.assertLessEqual(data["k"], data["limit"])

    def test_rejects_a_negative_with_relevant_chunks(self):
        bad = {"k": 3, "limit": 5, "questions": [{"id": "n", "kind": "negative", "query": "x", "relevant": ["a"]}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                run.load_golden(path)


if __name__ == "__main__":
    unittest.main()
