# kimi-lead

Kimi K3.1 Pro (preko OpenRoutera) je **tech lead**, a Claude Code je **inženjer**.
Ti pričaš s Kimijem. Kimi tvoj jezik pretvara u precizne tehničke zadatke za Claudea, bira pristup, pušta implementaciju, pregleda diff i javlja ti rezultat.
Kimi ne piše kod i sam odlučuje šta Claude vidi, u okviru tvojih pravila. Claudeov rad gledaš uživo.

## Instalacija

Potrebno: Node 22.6+, `git`, instaliran i prijavljen `claude` (Claude Code).

```bash
cd kimi-lead
npm link                      # dobiješ komandu `kimi-lead` svugdje
export OPENROUTER_API_KEY=sk-or-...      # Windows: setx OPENROUTER_API_KEY sk-or-...
```

Nema runtime zavisnosti (`npm install` treba samo za `npm run typecheck`).
`claude` se traži redom: `claude.path` u configu, `CLAUDE_BIN`, `PATH`, pa `~/.local/bin` (gdje ga stavlja native installer, i na Windowsu).

## Korištenje

```bash
cd ~/posao/neki-projekat
kimi-lead                     # interaktivno
kimi-lead "dodaj rate limiting na /api/orders"   # jedan zadatak pa izlaz
```

- Kimijev odgovor se ispisuje uživo, a svaki poziv Claudea je okvir u kojem vidiš **šta mu je Kimi poslao** i svaki Claudeov korak (Read, Edit +/−, Bash…).
- Dok Claude radi, **otkucana poruka ide direktno njemu** (upadanje). Kimi to ne vidi, ali vidi Claudeov izvještaj.
- **Ctrl+C** zaustavlja zadatak (i Kimija i Claudea). Drugi Ctrl+C kad ništa ne radi = izlaz.
- Komande: `/new`, `/sessions`, `/rules`, `/private`, `/exit`.

Prvo pokretanje napravi `.kimi/` u projektu i doda ga u `.git/info/exclude`, tako da ne ide u git:

| Fajl | Ko piše | Šta je |
|---|---|---|
| `RULES.md` | **samo ti** | Kako Kimi smije pričati s Claudeom, šta Claude smije znati, tvoj stil rada. Najviši prioritet. |
| `PRIVATE.md` | ti i Kimi | Ono što **samo Kimi** zna: klijenti, poslovni kontekst, zašto se nešto radi. Nikad ne ide Claudeu. |
| `config.json` | ti | Model, limiti i tvrde zaštite (vidi dolje). |
| `PROJECT.md`, `TASKS.md`, `DECISIONS.md` | Kimi (i ti) | Kimijeva dugoročna memorija o projektu. |
| `sessions.json` | alat | Claude Code sesije po temama (`auth`, `billing`…). Nastaviš ručno s `claude --resume <id>`. |
| `history.json` | alat | Kratka historija: tvoje poruke i Kimijevi izvještaji (`/new` je briše). |
| `log.md` | alat | Sve: tvoje poruke, svaki prompt Claudeu i odgovor, upozorenja. Claude ga nikad ne vidi. |

## Kako Kimi radi

1. Shvati cilj; po potrebi čita kod, ali u malim komadima (`read_file` najviše ~200 linija, `grep` ograničen broj pogodaka).
2. `ask_claude`: Claude u **read-only** modu istražuje i predlaže opcije (najviše `maxAskRounds` po zadatku).
3. Kimi bira pristup po tvojim pravilima (tu jače razmišlja: `decisionEffort`).
4. `implement`: Claude mijenja fajlove i pokreće samo dozvoljene komande (`implementAllow`).
5. Kimi pregleda diff, po potrebi vraća na doradu, ažurira bilješke i javi ti kratak izvještaj s troškom.

### Zašto Kimi ostaje brz

- Kimi od Claudea dobija samo kratak izvještaj; cijeli Claudeov rad vidiš ti, ne Kimi.
- Stara čitanja koda se automatski zamijene kratkom oznakom (`softTokens`).
- Kad se kontekst ipak napuni (`hardTokens`), Kimi sažme dosadašnji rad na zadatku i nastavi sa svježim kontekstom.
- Između zadataka se ne čuva sirovi razgovor, samo tvoje poruke, Kimijevi izvještaji i bilješke.
- System prompt je isti kroz cijeli zadatak (keširanje kod providera), OpenRouter bira najbržeg providera (`provider.sort`), a Kimi po defaultu malo razmišlja (`reasoningEffort: "low"`).

## Zaštite koje su u kodu, a ne samo u promptu

- **`forbidden`**: lista regexa (npr. `"ACME"`, `"Klijent\\s+X"`). Prompt Claudeu koji ih sadrži se blokira i Kimi mora preformulisati.
- **`denyRead`**: fajlovi koje ni Claude ni Kimi ne smiju čitati (`.env`, ključevi, `secrets/**`…). `.kimi/` je uvijek zabranjen Claudeu.
- **Read-only konsultacije**: u `ask_claude` Claude nema Edit/Write ni Bash osim `git status/diff/log/show` i `ls`.
- **Guard nakon implementacije**: ako Claude dirne zavisnosti, šemu baze ili migracije, obriše fajl ili dira deploy/CI, Kimi dobije upozorenje i mora te pitati ili tražiti da Claude to vrati. Hvata i ponovnu izmjenu fajla koji je već bio izmijenjen.
- Claude nikad ne smije `git push`, `git reset`, `git checkout`, `git clean` ni `rm`.
- **Tvoja globalna Claude podešavanja se ne učitavaju** (`claude.userSettings: false`). Inače bi npr. `"allow": ["Bash"]` iz `~/.claude/settings.json` zaobišao sve gore. Projektna `.claude/settings.json` i `CLAUDE.md` važe normalno.

## config.json

```json
{
  "model": "moonshotai/kimi-k3.1-pro",
  "provider": { "sort": "throughput" },
  "reasoningEffort": "low",
  "decisionEffort": "medium",
  "maxAskRounds": 3,
  "maxSteps": 60,
  "context": { "softTokens": 24000, "hardTokens": 40000, "keepTaskPairs": 8 },
  "read": { "maxLines": 200, "maxChars": 12000, "grepMax": 40 },
  "claude": {
    "path": null,                  // null = auto-detect
    "userSettings": false,         // true = učitaj i ~/.claude/settings.json (zaobilazi zaštite!)
    "model": null,                 // npr. "opus"; null = tvoj default
    "effort": null,
    "maxBudgetUsdPerCall": null,
    "reportMaxChars": 6000,
    "implementAllow": ["Bash(npm test:*)", "Bash(npm run lint:*)"],
    "denyRead": [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"]
  },
  "forbidden": []
}
```

Za Go projekat, recimo: `"implementAllow": ["Bash(go test:*)", "Bash(go vet:*)"]`.

## Prije korištenja na poslu

- Kimi preko OpenRoutera vidi kod koji pročita. **Pitaj firmu** da li to smiješ, i po potrebi ograniči providera u OpenRouter postavkama.
- `claude -p` prijavljen tvojim Claude planom troši limite tvoje pretplate (stanje oktobar 2026). Kimi može pozvati Claudea više puta po zadatku.
- Radi na zasebnoj git grani. Kimi ne commita; commit i push su tvoji.
