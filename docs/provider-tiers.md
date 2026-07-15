# Provider reputability tiers

Web-researched 2026-07-15 (sources: vendor privacy policies, TechCrunch, CNBC,
The Register, The Hacker News, PitchBook, scamadviser, and vendor docs; full
per-provider citations in the research notes below). Basis for running two
router instances segregated by data-privacy posture:

- **Clean instance** (host `:3001` — the default port on purpose, so a client
  that never chose a tier fails safe) — Tier A only. Prompts you would not
  paste in a public gist may go here.
- **Gray instance** (host `:3003`, `docker-compose.tiers.yml`) — everything
  else worth keeping, opt-in for public-grade prompts wanting the full free
  catalog. Assume every prompt is logged and may be used for training.
- **Dropped** — providers whose operator risk isn't priced by "prompts are
  public": dead or malicious upstreams also poison fallback chains.

Re-verify roughly quarterly: three of the Tier A/B verdicts below changed
between Jan and Jul 2026 (Groq ownership, GitHub training default, Reka
merger), so this table has a shelf life.

## Tier A — trusted (no-train, zero/short retention, reputable operator)

| Provider | Basis (2026-07) |
|---|---|
| Cerebras | No retention of prompts/outputs, no training; public company (IPO 2026-05-14). |
| Cloudflare Workers AI | Contractual no-training; first-party edge inference, no third-party fan-out. |
| Ollama Cloud | Policy (rev 2026-03): transient processing, "never train on it"; NVIDIA Cloud partner contracts require zero retention. |
| OVHcloud AI Endpoints | EU (French public co.), GDPR; zero retention beyond billing metadata, never trains. Keyless tier included. |
| Requesty | UK/EU, ZDR mode, encrypted EU storage max 30 days when logging on; no training; GDPR/SOC2 claims. |
| Mistral * | **Conditional**: free Experiment tier trains BY DEFAULT. Tier A only with Admin Console → Privacy → "Allow the use of your API calls to train" OFF — flipped 2026-07-15, so enabled on clean. Keep "Labs models" OFF too: Labs trains regardless of the opt-out. EU jurisdiction. |

## Tier B — gray (assume logged; case-by-case)

| Provider | Why not A |
|---|---|
| Google (Gemini free) | Free tier trains on prompts with human review; EEA/UK carve-out gets paid-tier terms. |
| Groq | Good policy (no-train, 7-day logs, ZDR option) but NVIDIA acqui-hire 2025-12-24; policy continuity under new leadership unproven. Groq ≠ Grok/xAI. |
| GitHub Models | Microsoft flipped Copilot free tiers to default-training 2026-04-24. Account toggle "Allow GitHub to use my data for AI model training" verified Disabled 2026-07-15; whether Models API inference is inside that toggle's scope remains unverified, so stays gray. |
| OpenRouter | Itself clean (no prompt logging, ZDR param) but `:free` routes terminate at train-happy third-party hosts. Account Data Policies verified 2026-07-15: paid-may-train OFF, free-may-train ON (keeps the :free catalog; gray assumption covers it), free-may-publish OFF, 1% data discount OFF, ZDR enforcement off. |
| HuggingFace Router | Fans out to ~7 partner hosts with heterogeneous retention; weak platform security record (2 RCE CVEs in 2026). |
| SiliconFlow | Singapore paper entity, Beijing operations; policy silent on training, vague retention. |
| Reka | Merged into Moonvalley 2026-05-10; policy (rev 2026-07-15) trains on free-tier prompts; API product strategically adrift. |
| Kilo Gateway | Funded US co. (GitLab co-founder), honest disclosure: free routes log + train by design. |
| Pollinations | 5-person Berlin OSS shop; EU but no verifiable retention policy; Dec 2025 NSFW safety regression. |
| OpenCode Zen | Clearest per-model disclosure of the set; paid routes are A-grade (ZDR), free models declared train-on-data. |
| BazaarLink | Named Taiwan entity, strong written no-train policy (eff. 2026-02-01), but small/unaudited. |
| AINative Studio | US entity, explicit no-train, but 365-day retention on registered data, unproven. |
| Aion Labs | Polish entity; collects prompts, retention "as long as necessary", no training disclaimer. |
| AI Horde | Maximally transparent + non-commercial, but volunteer workers can read prompts — confidentiality structurally absent. Treat prompts as public. |
| NVIDIA NIM † | Free endpoints explicitly record + train on prompts; NVIDIA warns against confidential data. |
| Cohere (trial) † | Trial keys train on prompts, no opt-out (opt-out is enterprise-only). |
| Zhipu † | Free key runs on mainland bigmodel.cn: PRC data-law exposure + US Entity List (Jan 2025). Intl z.ai policy does not cover it. |
| LLM7 † | One individual (Cambridge, UK), no legal entity; policy silent on prompt retention; relays via Pollinations. |
| Agnes AI † | Real funding but opaque/unfetchable data policy; free at claimed 4T tokens/week means data is the payment. |

† Originally rated Tier C for privacy; kept on the gray instance because gray
traffic is public-grade by definition and they provide real capacity. The C
rating still matters if a third, stricter split is ever wanted.

## Dropped — not configured on any instance

| Provider | Red flags |
|---|---|
| Routeway | Anonymous operator, WHOIS-privacy, <1yr-old domain, no visible revenue model. |
| NaraRouter | Anonymous ops, no privacy policy found, free Claude Sonnet 4.5 at millions of tokens/day — classic leaked/pooled-key economics. |

## xAI / Grok note

Not a provider here; only reachable via OpenRouter `grok-*:free` routes.
Jul 2026: Grok Build CLI shipped users' entire git repos (history + committed
secrets) to a GCS bucket while its privacy toggle did nothing (The Register,
The Hacker News, 2026-07-14); Canada OPC has open PIPEDA findings against
X Corp/xAI. Exclude grok models from any chain on the clean instance and
prefer excluding them on gray too.
