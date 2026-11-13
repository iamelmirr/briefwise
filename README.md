# kimi-lead

Kimi K3.1 Pro (preko OpenRoutera) je **tech lead**, a Claude Code je **inženjer**.
Ti pričaš samo s Kimijem. Kimi čita projekat, konsultuje Claudea, bira pristup, pušta implementaciju, pregleda diff i javlja ti rezultat.
Kimi ne piše kod i sam odlučuje šta Claude vidi, u okviru tvojih pravila.

## Instalacija

Potrebno: Node 22.6+, `git`, instaliran i prijavljen `claude` (Claude Code). Najbolje radi na Linuxu, macOS-u ili WSL-u.

```bash
cd kimi-lead
npm link                      # dobiješ komandu `kimi-lead` svugdje
export OPENROUTER_API_KEY=sk-or-...
```

Nema npm zavisnosti.

## Korištenje

```bash
cd ~/posao/neki-projekat
kimi-lead                     # interaktivno
kimi-lead "dodaj rate limiting na /api/orders"   # jedan zadatak pa izlaz
```

Komande u interaktivnom modu: `/new`, `/sessions`, `/rules`, `/exit`.

Prvo pokretanje napravi folder `.kimi/` u projektu i automatski ga doda u `.git/info/exclude`, tako da ne ide u git firme:

| Fajl | Ko piše | Šta je |
|---|---|---|
| `RULES.md` | **samo ti** | Kako Kimi smije pričati s Claudeom, šta Claude smije znati, tvoj stil rada. Najviši prioritet. |
| `config.json` | ti | Model, limiti i tvrde zaštite (vidi dolje). |
| `PROJECT.md`, `TASKS.md`, `DECISIONS.md` | Kimi (i ti) | Kimijeva dugoročna memorija o projektu. |
| `sessions.json` | alat | Claude Code sesije po temama (`auth`, `billing`…). |
| `history.json` | alat | Razgovor s Kimijem (`/new` ga briše). |
| `log.md` | alat | Sve: tvoje poruke, svaki prompt Claudeu i odgovor, upozorenja. Claude ga nikad ne vidi. |

## Kako Kimi radi

1. Shvati cilj i po potrebi čita kod (read-only: `list_files`, `read_file`, `grep`, `git status/diff/log`).
2. `ask_claude`: Claude u **read-only** modu istražuje i predlaže opcije. Najviše `maxAskRounds` (3) puta po zadatku.
3. Kimi bira pristup po tvojim pravilima.
4. `implement`: Claude mijenja fajlove i pokreće samo dozvoljene komande (`implementAllow`).
5. Kimi pregleda diff i po potrebi vraća na doradu.
6. `finish`: kratak izvještaj tebi, plus trošak (Kimi + Claude).

Radi sam do kraja. Staje i pita te samo za odobrenja ili ako cilj stvarno nije jasan.

## Zaštite koje su u kodu, a ne samo u promptu

- **`forbidden`** u `config.json`: lista regexa (npr. `"ACME"`, `"Klijent\\s+X"`). Ako Kimi pokuša poslati Claudeu prompt s nečim od toga, poziv se blokira i Kimi mora preformulisati.
- **`denyRead`**: fajlovi koje Claude ne smije čitati ni mijenjati (`.env`, ključevi, `secrets/**`…). `.kimi/` je uvijek zabranjen.
- **Read-only konsultacije**: u `ask_claude` Claude nema Edit/Write.
- **Guard nakon implementacije**: ako Claude dirne zavisnosti, šemu baze ili migracije, obriše fajl ili dira deploy/CI, Kimi dobije upozorenje i mora te pitati ili tražiti da Claude to vrati.
- Claude nikad ne smije `git push`, `git reset`, `git checkout` ni `rm`.

Napomena: Claude i dalje može pročitati bilo koji fajl u repou koji nije u `denyRead`. Ako nešto ne smije vidjeti, dodaj to u `denyRead`, ne samo u `RULES.md`.

## config.json

```json
{
  "model": "moonshotai/kimi-k3.1-pro",
  "maxAskRounds": 3,
  "maxSteps": 60,
  "claude": {
    "model": null,                 // npr. "opus"; null = tvoj default
    "effort": null,
    "maxBudgetUsdPerCall": null,
    "implementAllow": ["Bash(npm test:*)", "Bash(npm run lint:*)"],
    "denyRead": [".env", ".env.*", "secrets/**"]
  },
  "forbidden": []
}
```

Za Go projekat, recimo: `"implementAllow": ["Bash(go test:*)", "Bash(go vet:*)"]`.

## Prije korištenja na poslu

- Kimi preko OpenRoutera vidi kod koji pročita. **Pitaj firmu** da li to smiješ, i po potrebi ograniči providera u OpenRouter postavkama.
- Provjeri da li tvoj Claude plan pokriva ovakvo automatsko pokretanje `claude -p` ili ti treba API ključ.
- Radi na zasebnoj git grani. Kimi ne commita; commit i push su tvoji.
