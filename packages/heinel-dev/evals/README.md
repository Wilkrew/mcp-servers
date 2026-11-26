# Search evals

AI agents use the `search` tool, in this package and at [heinel.dev/mcp](https://heinel.dev/mcp), to answer questions about my work. These evals measure whether it finds the right part of the site.

They ask an endpoint 50 questions, the way an agent would, and check the answers against the parts of the site (chunks) that should come back. This repo's CI runs them against the package, and heinel.dev's CI runs the same files against the site on every change to its content or MCP code. Both use the same search code and data, so they give the same results. A run fails if a score drops below the gate.

## What's measured

- **hit@1 and hit@3:** of the 43 questions that should find something, the share where a right chunk comes first, or in the top three.
- **MRR** (mean reciprocal rank): 1 for a right chunk first, 1/2 for second, and so on, averaged over those 43 questions. A question with no right chunk among the results scores 0.
- **Negatives:** of the 7 questions that should find nothing, the share that do. Two of them search for `undefined` and `NaN`, to catch content that renders broken.

Results are reported by kind of question: keywords, questions in plain English, Swedish, and negatives.

## Results

| | hit@1 | hit@3 | MRR | Negatives |
|---|---|---|---|---|
| Before, 26 Nov 2026 | 63% | 72% | 0.68 | 71% |
| After the three fixes below | 86% | 93% | 0.89 | 86% |
| After two wording changes on the site | 88% | 98% | 0.92 | 86% |

The first runs found three problems, in the site's copy of the search and in this one:

1. **Two case sections were unsearchable.** The engineering notes for Nether and Murderhouse are plain sentences, but the site's chunker expected named lines. It turned them into "undefined: undefined …", so Drizzle, row-level security and the Playwright and axe tests couldn't be found.
2. **Two premises were indexed differently.** Nether's and Murderhouse's premise is a list of paragraphs. The site left them out, and this package joined them with commas. Comparing the two showed it, and both now join the paragraphs the same way and build identical chunks (`src/data.ts`).
3. **Plain-English questions found the recommendations.** "What did he do at Affärsvärlden?" ranked a recommendation first, because the recommendations are the only text that says "he". Question and function words, in English and Swedish, and my name, which is in every question about me, are now left out of the index (`src/search.ts`).

No question got worse. Plain-English questions went from 55% to 91% at hit@3.

Two more misses were gaps in the site's wording, not in the search. The site said agents could be "hijacked", never "prompt injection", and "conscription" and "army ranger", never "military service". A keyword index can't bridge a different word for the same thing, so the site now uses both. That raises the score by changing the content rather than the search, so the table shows it as a row of its own.

The evals also caught a change of mine. A new line on the site about these evals said "the right answer is now in the top three", and it came first for "What is he working on right now?". It was reworded.

### Still missed, on purpose

These two questions stay in the set, because they show where keyword search stops:

- **"projektledning":** the index is the English site, so a Swedish word finds nothing unless the English text also has it.
- **"Does he know Kubernetes?":** "know" matches "know-how" elsewhere. Keywords would have found nothing, as intended.

## Run it

From `packages/heinel-dev`, start the package's HTTP endpoint, then run the evals against it:

```bash
npm run serve                                    # http://localhost:3333/mcp
python3 evals/search/run.py                      # in another terminal
python3 -m unittest discover -s evals/search     # tests for the runner, with a fake endpoint
```

Against the live site, slow down to stay under its rate limit of 60 requests a minute:

```bash
python3 evals/search/run.py --url https://heinel.dev/mcp --delay 1.2
```

`--markdown report.md` and `--json results.json` save the report. The runner uses Python's standard library only (3.10 or newer), so there's nothing to install.

## Adding or changing questions

The questions and their right chunks are in `search/golden.json`. heinel.dev's CI fetches this folder from `main`, so a change here applies to the site too.

1. **Write the question first,** the way a recruiter or an agent would ask it, before looking at the site's wording. Then find every chunk that answers it. Chunk ids are built in `src/data.ts` (`work:affarsvarlden`, `case:nether#engineering` and so on); a search result shows each one's id.
2. **Never reword a question to make it pass.** A miss is a finding: fix the search or the content, or keep the question as a known miss with a `note`.
3. **When content moves,** update the chunk ids, and say why in the commit.
4. **The gate is a floor.** It is set to the latest scores, so any drop fails the run. When a change raises the scores, raise the gate in the same pull request.

## Limits

- I wrote both the content and the questions, so the questions lean towards my own wording, and the scores are likely higher than real visitors would get. Questions taken from real use would be better, but neither endpoint keeps logs, on purpose.
- This measures retrieval, not answers. Whether an agent then answers correctly from the chunks is a separate eval, and would need a model and an API budget.
- heinel.dev has its own copy of the search code, which must stay the same as `src/data.ts` and `src/search.ts`. Running the same evals in both CIs is what keeps them honest.
